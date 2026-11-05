# 13 — DLNA video cast to TVs (Samsung, Fire TV)

Status: Implemented (initial scope)
Priority: standalone feature
Estimated effort: Medium

## Outcome

Cast the video playing in the active tab to a TV on the local network using DLNA/UPnP, covering Samsung TVs natively and Fire TVs via their built-in DLNA support or a receiver app (AirScreen, Nova).

## Non-goals

- Screen mirroring (Miracast/Smart View, AirPlay mirroring): not feasible from Electron; these are OS-level protocols.
- DRM streams (Netflix, Disney+): cannot be cast; the same restriction applies to real Chrome casting.

## Implementation

- `dlna-cast-manager.js` (main process): SSDP M-SEARCH for `urn:schemas-upnp-org:device:MediaRenderer:1`, device description fetch, AVTransport control URL resolution, `SetAVTransportURI` + `Play`/`Stop` SOAP calls. Node built-ins only.
- IPC: `cast-discover-devices`, `cast-video`, `cast-stop` (host-browser renderer only, via preload whitelist).
- `cast-panel.js` (renderer): panel opened from the More menu ("Cast to TV"), device discovery with selection, and video extraction from the active webview (`<video>` sources, direct-stream page titles).
- Only direct `http(s)` video URLs can be cast; HLS (`.m3u8`) support depends on the target TV.

## Limits and safety

- Discovery and cast are restricted to the host browser renderer; site webviews cannot invoke cast IPC.
- Discovery result list is bounded (24 devices, bounded description bodies).
- SOAP requests carry a 5s timeout; search runs for 3s per discovery round.
- Playback control (play/pause/seek) is intentionally left to the TV remote; the browser only starts and stops the cast.

## Follow-up: subtitles and stop (implemented)

- `subtitle-converter.js`: WebVTT → SRT conversion (tolerant timecode parsing, inline tag stripping, entity decoding).
- `cast-media-extractor.js`: extracts caption cues from the page video's `textTracks` (forcing disabled tracks to load) with a `<track src>` sidecar fallback.
- `cast-relay-service.js`: `serveSubtitle()` serves generated SRT bytes at `/cast/<token>/subtitle.srt` — attached to the active relay route when video is relayed (same host:port as the media, which Samsung requires), or as a standalone route for direct-URL casts.
- `dlna-cast-manager.js`: `setVideo`/`play`/`pause` split; when a `subtitleUrl` is supplied, DIDL metadata includes the SRT `<res>` plus Samsung `pv:captionInfo` and `sec:CaptionInfo` extensions (overrides metadata omission, since captions require it).
- `main.js`: extracted cues are stored under a one-shot token between `cast-extract-video` and the cast handlers (bounded store); `<track src>` sidecars are fetched via the tab's session and converted.
- `cast-panel.js`: "Stop casting" button (stops the TV renderer and tears down the relay) and a subtitle availability hint in the status line.
- Users enable captions with the TV remote's CC/Subtitle button; DRM video cannot carry subtitles.

## Follow-up: TV transport controls (implemented)

- **Stop hang fix**: `castRelayService.stop()` previously waited on `server.close()` while the TV held the media connection open, so `cast-stop` (and every later `start()`) never resolved and panel buttons stuck disabled. Now closes connections eagerly with a bailout timeout.
- **Seekable capture relay**: `stream.ts` no longer pipes ffmpeg per request. One ffmpeg per route captures the remuxed transport stream into a temp file; the relay serves it with `Accept-Ranges: bytes` / `Content-Range`, so Samsung enables pause, rewind, and forward seek (stalls up to 30s until the capture reaches the target, then 416). Pause/resume keeps its position because reconnections resume at their byte offset.
- `X-Content-Duration` (VOD playlists only) gives the TV a real seek bar.
- Direct file casts always supported ranges via passthrough; the capture applies to relayed HLS.
- Capture temp dirs are removed on stop; the cast source probe now times out after 15s so a stalled origin cannot wedge the Cast button.

## Acceptance criteria

- [x] Devices on the LAN are discovered with friendly names and AVTransport endpoints.
- [x] Casting sends the active tab's direct video URL with DIDL metadata and starts playback.
- [x] Non-host renderers and site pages cannot invoke the cast channels.
- [x] Focused unit tests cover description parsing, SOAP envelope construction, and discovery response parsing.
