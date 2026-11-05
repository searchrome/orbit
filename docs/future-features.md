# Deferred product features

These items are recorded for future design and implementation. They are not available in the browser today.

## Public artifact sharing

Users should be able to make an artifact available at a public HTTPS URL, then copy or share that URL. The address bar should show the public domain while the shared artifact is open. A Share control belongs immediately before the bookmark control and should appear only for eligible artifact pages.

This needs an upload and hosting service; a local Electron server cannot make an artifact reachable from the internet. Evaluate an object-storage/CDN design (for example S3-compatible storage plus a dedicated domain) against an application server that can issue expiring, revocable links.

Before implementation, decide:

- whether sharing is public, account-scoped, password-protected, or time-limited;
- whether copying a local artifact link itself may publish content, or whether publishing must always require an explicit Share action and confirmation;
- upload size/type limits, malware scanning, content-security policy, ownership, deletion, and link revocation;
- how the app persists upload state and safely maps a local artifact to its public URL.

## Live transformed proxy pages

Users may want a live alternative view of an existing web page, such as an ad-reduced reading view or an AI-redesigned page that continues to reflect the source site.

The local first version uses an OpenCode-authored saved transformation recipe. Opening or refreshing the view loads current source content and reapplies that recipe without another LLM call. It needs a browser-managed source loader and rendering runtime, but no public proxy server. Public hosting remains separate future work.

First version: read-only transformed views for public pages, with source attribution, a persistent view identity, browser reload support and an in-page Refresh button. See the [developer design](task/live-transformed-page-design.md) for architecture, contracts, refresh behavior and acceptance checks. This remains documentation-only until implementation is requested.
