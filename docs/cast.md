# Casting to TV — Status, Architecture & Roadmap

Last updated: 2026-09-17
Owner: browser project
Related: `docs/tickets/13-dlna-video-cast.md`

---

## 1. What this feature is

Cast the video playing in the active tab to a TV on the local network. The
browser extracts the video (and any subtitle track) from the tab, relays a
TV-compatible stream from a local HTTP server, and hands the TV a temporary
local URL via DLNA/UPnP.

Entry point: the **"Cast to TV"** button in the More (`…`) menu opens the cast
panel (`#cast-panel` in `index.html`), driven by `cast-panel.js` in the renderer.

Key files:

| File | Role |
|------|------|
| `dlna-cast-manager.js` | Main process. SSDP discovery, device description parse, AVTransport SOAP (`SetAVTransportURI`, `Play`, `Pause`, `Seek`, `Stop`, `GetTransportInfo`, `GetPositionInfo`). |
| `cast-relay-service.js` | Main process. Local HTTP relay: HLS→transmux capture, `stream.<ext>` serving with ranges, subtitle sidecar, `transferMode`/`content-length` signalling. |
| `cast-stream-registry.js` | Tracks observed tab media streams (HLS/file) the relay can reuse. |
| `cast-media-extractor.js` | Reads `<video>` sources + subtitle `textTracks`/`<track src>` from the webview. |
| `cast-panel.js` | Renderer UI: device list, cast/stop, and the play/pause/seek/scrub session controls. |
| `main.js` | IPC handlers: `cast-discover-devices`, `cast-extract-video`, `cast-relay-video`, `cast-video`, `cast-stop`, `cast-play`, `cast-pause`, `cast-seek`, `cast-status`. |

---

## 2. How a cast works (relay path)

1. `cast-extract-video` reads the active tab: direct video URL **or** an HLS
   playlist, plus any subtitle cues / track URL. Subtitles found → a one-shot
   token is stored in `castSubtitleStore` (bounded, main.js).
2. For HLS, `cast-relay-video` → `startRelayCast()`:
   - `CastRelayService.start()` fetches the playlist, then returns a tokenized
     URL `http://<lan-ip>:<port>/cast/<token>/stream.<ext>`.
   - `prewarmCapture()` starts an **ffmpeg** transmux of the HLS into a local
     file.
   - Subtitles (if any) are converted to SRT and served at
     `…/subtitle.srt` on the **same host:port** as the video.
   - `SetAVTransportURI` is sent with DIDL metadata that includes the video
     `<res>` + a subtitle `<res>` + Samsung `pv:`/`sec:` caption extensions.
   - **Play is held back until the capture finishes**, so the TV fetches a
     *finite* file instead of a live feed.
3. The panel opens a session and polls `cast-status` (`GetTransportInfo` /
   `GetPositionInfo`) every 2s to drive the progress bar and controls.

### Current remux command (HLS)

```
ffmpeg -c:v copy -c:a aac -ac 2 -b:a 256k -movflags +faststart -f mp4
```

- Video is **copied** (no re-encode).
- Audio is **transcoded to AAC stereo** — an MP4 must carry AAC to play sound
  on every TV (AC3/E-AC3 passthrough works in a transport stream but not MP4).
- `+faststart` moves the `moov` seek table to byte 0 so the file is seekable
  from the first byte.

---

## 3. What is working

- **Device discovery** — SSDP M-SEARCH for `MediaRenderer:1` (+ broad search),
  device-description fetch, AVTransport control-URL resolution.
- **Video + audio playback on the TV.** Since the remux target was switched
  from MPEG-TS to a seekable **MP4**, the TV plays picture *and* sound. (MPEG-TS
  played but was not seekable; see §4.)
- **Finite-file signalling.** The finished capture is served with
  `content-length`, `accept-ranges: bytes`, `transferMode.dlna.org: Interactive`,
  and `206` Partial Content on range requests — all the headers a VOD renderer
  expects.
- **Seek ladder.** A panel seek tries, in order: `REL_TIME` → `ABS_TIME` →
  **re-Set at position + Play** (the same media URI re-sent with a
  `startAt` target applied before `Play`). The last step makes seeking work on
  renderers that refuse mid-playback seeks but accept one right after a Set;
  with the capture cache the reload is instant. If positioning is refused in
  every state the seek reports unsupported instead of silently restarting.
  SOAP calls and results are logged to `/tmp/cast-relay-debug.log`.
- **Capture cache (no re-download).** A cleanly finished capture is promoted
  to `<userData>/cast-cache/<sha1>.mp4` (8 GB LRU budget, `index.json`
  sidecar). The cache key is `sha1(pageUrl | streamUrl-without-query | kind |
  subtitle-choice | segmentCount | duration)` — stable across refetches even
  though signed segment URLs rotate. A cache hit serves the stored MP4
  instantly (no download, no remux); the panel notes "Reused the earlier
  download." Different videos or a picked subtitle get their own entry.
- **Preparation wait.** Play is sent only after the capture truly finishes (a
  partial faststart MP4 has no `moov` atom and no renderer can play it — the
  TV just spins, then reports a connection error). Long VODs take minutes;
  the panel shows live progress via `cast-progress` (percent when the playlist
  declared segments, plus captured MB), with a 20-minute cap and a 60-second
  no-growth stall watchdog.
- **Subtitles (relay path).** Cues are extracted from the tab's `<video>`,
  converted to SRT, served on the **same host:port** as the video, and attached
  in DIDL via `pv:captionInfo` / `sec:CaptionInfo`. Display depends on the TV's
  caption support (Samsung: enable CC with the remote).
- **Stop casting** — tears down the relay and sends `Stop`.
- **No sleep during casts** — a `powerSaveBlocker` (`prevent-app-suspension`)
  is held for the whole cast: the machine stays awake (relay keeps serving the
  TV) while the display may still sleep on its own schedule. Released on
  `cast-stop`, when the `cast-status` poll reports `STOPPED`/`NO_MEDIA_PRESENT`
  (TV ended playback on its own), on cast failure, and at window close/quit.
- **PNG-disguised HLS segments** — some sources wrap each transport segment in
  a tiny 1×1 PNG stub to defeat direct downloads. The relay detects the stub
  (`IEND` within the first 4 KB) and strips it before the bytes reach ffmpeg
  or the TV, adjusting `content-length` accordingly. If a remux still fails,
  the cast now fails fast with the remuxer's error instead of sending the TV
  an empty file (which renderers report as a generic "An error occurred").
- **Cast panel UI** — device list, cast/stop, and the play/pause/seek/scrub
  session controls with a live progress bar and time display.
- **Safety/scope** — cast IPC is restricted to the host-browser renderer; the
  assistant/workspace tab is protected; DRM streams are not cast.

---

## 4. What is NOT working (and why)

### 4.1 Pause / Seek / Forward over DLNA → `UPnP 701` (the blocker)

Symptom: `Cast Pause failed: Transition not available (UPnP 701)`.

Root cause: **the TV's DLNA renderer does not implement AVTransport
pause/seek.** Confirmed, not a header/container bug:

- The debug log (`/tmp/cast-relay-debug.log`) shows the TV fetch
  `stream.mp4` with a plain `GET` and **no `Range` header** — a linear
  download. A renderer that supported seeking would probe with
  `Range: bytes=0-N` first.
- `701` is the renderer refusing a transition it doesn't support.
- Every VOD signal was applied and playback is fine, yet pause/seek still
  return 701: finite MP4 + `content-length` + `transferMode: Interactive` +
  `DLNA.ORG_OP=01` seek flags + `+faststart`. The renderer plays the file but
  offers no trick modes.

This was verified against a **Fire TV** (Fire OS). Its built-in DLNA renderer
plays video/audio but has no pause/seek. **No code change to the DLNA path can
add a trick mode a renderer doesn't implement.**

Attempts already made (all necessary for playback, none sufficient for
controls):

1. Always send the seek-advertising `<res protocolInfo>` in `SetAVTransportURI`
   (was sending empty metadata).
2. `content-length` on the HEAD probe for a finished capture.
3. `transferMode.dlna.org: Interactive` (was `Streaming`, which marks it live).
4. Remux to seekable MP4 instead of MPEG-TS.

### 4.2 Subtitle limitations

- **Direct-URL casts** serve the subtitle on a *separate* tokenized route
  (different host:port from the remote media URL). Samsung renderers require the
  subtitle on the same host:port as the media and silently ignore it. (The relay
  path serves same-host and works.)
- Subtitle display requires the TV to support and enable captions (e.g. CC on
  Samsung). Unconfirmed on the current Fire TV.

### 4.3 Known scope limits

- DRM-protected streams (Netflix, Disney+, …) cannot be cast.
- The "Preparing the video…" wait is the full-download + remux time; it is what
  makes the file finite/seekable, so it is inherent to the relay approach.

---

## 5. Paths forward for transport controls

The user wants **big screen + controls + subtitles** together. DLNA to the
built-in Fire TV renderer gives big screen + subtitles but not controls.

### Path A — full-featured receiver on the TV (recommended, fastest)

Run **AirScreen** on the Fire TV. It exposes an AirPlay/DLNA receiver that
*does* support **pause / seek / scrub + subtitles**. Cast from the panel to the
`AS-…` AirScreen device instead of the built-in renderer.

- Pros: all three work, no (or minimal) code changes, works today.
- Cons: third-party receiver app on the TV.
- Branch: `feature/cast-airscreen` (this branch).
- Follow-up on this branch: make the panel gracefully hide/disable the
  pause/seek/scrub buttons when a renderer rejects them (so the built-in Fire TV
  device stops surfacing `701`), while keeping them enabled for AirScreen.

### Path B — our own Fire TV receiver (fully in-app, larger)

A small Android/ExoPlayer app sideloaded on the Fire TV, driven over the local
network from the cast panel (play/pause/seek/subtitle API). ExoPlayer gives
proper controls + subs natively.

- Pros: all three, fully ours, no third-party.
- Cons: multi-day build (Android app + pairing + Mac↔TV protocol) + sideload.

### Path C — accept play/stop + subs on built-in DLNA

2 of 3. Only if trick modes on the built-in renderer are not required.

---

## 6. Testing

- Unit: `__tests__/unit/dlna-cast-manager.test.js`,
  `__tests__/unit/cast-relay-service.test.js` (26 tests, all passing).
  Covers SOAP flows, timecode parse, seek/getStatus, HEAD `content-length` +
  `transferMode: Interactive`, MP4 remux args, subtitle sidecar.
- Integration: `__tests__/integration/dlna-cast-controls.test.js` — a loopback
  DLNA renderer (real HTTP + SOAP AVTransport + transport state machine) that
  **reproduces the `UPnP 701`** for a live-classified stream and verifies
  play/pause/seek/getStatus for a finite VOD cast.

Real-TV verification still requires a physical TV / receiver (AirScreen).

## 7. Debugging

- Relay debug log: `/tmp/cast-relay-debug.log` (set by `CAST_DEBUG_LOG` in
  `cast-relay-service.js`). Shows every `stream.mp4`/`subtitle.srt`/`resource`
  request with `range`, `timeseekerange`, user-agent, and capture lifecycle.
- The TV's user-agent appears as `Lavf/…` (ffmpeg) when it fetches via its own
  downloader.
