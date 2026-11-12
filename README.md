# DashPlay — M3U8, MPD (DASH Protection), FLV, MP4 & MKV Web Player

DashPlay is a browser-based video player for direct **HLS (`.m3u8`)**, **MPEG-DASH (`.mpd`)**, **FLV (`.flv`)**, **MP4 (`.mp4`)**, and **Matroska (`.mkv`)** links. It runs entirely with client-side HTML, CSS, and JavaScript — ready to host directly on **GitHub Pages** without a backend server.

## Features

- **Open any `.m3u8`, `.mpd`, `.flv`, `.mp4`, or `.mkv`**:
  - Automatic format detection from the URL, with a manual format selector (`Auto-detect`, `HLS (.m3u8)`, `DASH (.mpd)`, `FLV (.flv)`, `MP4 (.mp4)`, `MKV (.mkv)`).
  - Live stream support for HLS, DASH, FLV, and growing fragmented MP4 (`Live FLV / MP4`), with a **Live** button to jump to the live edge.
  - Adaptive or manual video quality selection for both HLS (`.m3u8`) master playlists and DASH (`.mpd`) multi-representation manifests.
- **Per-site headers**:
  - Save custom request headers (such as `Referer`, `Origin`, `Authorization`, or custom token headers) per stream host (matching the host and its subdomains) for streams that otherwise return `403 Forbidden` errors.
  - Applied to HLS (`hls.js`), DASH (`dash.js`), FLV (`mpegts.js`), and Live MP4 (`fetch`) requests, and persisted locally in `localStorage`.
- **DASH Protection**:
  - Enter a **License URL**, optional **License Request Headers**, and **Robustness Level** (e.g. `SW_SECURE_DECODE`, `SW_SECURE_CRYPTO`, `HW_SECURE_DECODE`) when an encrypted `.mpd` stream requires it.
  - Automatically prompts when an encrypted DASH stream encounters a key-system or protection error, and optionally remembers configurations per stream host.
- **Shareable links for friends**:
  - Click **Copy shareable link** to generate a single link containing the stream URL, format, per-site request headers, and DASH Protection configuration:
    - **Admin Only** (`?s=<slug>`) — Ultra-short preset links backed by `streams.json` in your GitHub repository (with one-click GitHub Auto-Sync for the repository owner).
    - **Compact (`?z=…`)** — Self-contained compressed token links that work immediately for anyone without committing to `streams.json`
- **Save screenshot**:
  - Download the current video frame as a full-resolution PNG.

## Hosting on GitHub Pages

1. Push this directory to a GitHub repository.
2. In your repository on GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**, select **Deploy from a branch**, choose your branch (e.g. `main`) and `/ (root)`, and click **Save**.
4. Your player will be live at `https://<your-username>.github.io/<repo-name>/`.

## Bundled Libraries (`vendor/`)

- [hls.js 1.6.13](https://github.com/video-dev/hls.js) — HLS (`.m3u8`) playback and quality selection.
- [dash.js 5.1.1](https://github.com/Dash-Industry-Forum/dash.js) — MPEG-DASH (`.mpd`) playback, DASH Protection (`setProtectionData`), and request/license interceptors.
- [mpegts.js 1.8.0](https://github.com/xqq/mpegts.js) — FLV (`.flv`) VOD and live playback through Media Source Extensions.
- [MP4Box.js 2.4.1](https://github.com/gpac/mp4box.js) — initialization metadata parser for live fragmented MP4.
