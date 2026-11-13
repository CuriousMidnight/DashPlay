# DashPlay — M3U8, MPD, FLV, MP4 & MKV Web Player

DashPlay is a browser-based video player for direct **HLS (`.m3u8`)**, **MPEG-DASH (`.mpd`)**, **FLV (`.flv`)**, **MP4 (`.mp4`)**, and **Matroska (`.mkv`)** links. It runs entirely with client-side HTML, CSS, and JavaScript — ready to host directly on **GitHub Pages** without a backend server.

## Features

- **Open any `.m3u8`, `.mpd`, `.flv`, `.mp4`, or `.mkv`**:
  - Automatic format detection from the URL, with a manual format selector (`Auto-detect`, `HLS (.m3u8)`, `DASH (.mpd)`, `FLV (.flv)`, `MP4 (.mp4)`, `MKV (.mkv)`).
  - Live stream support for HLS, DASH, FLV, and growing fragmented MP4 (`Live FLV / MP4`), with a **Live** button to jump to the live edge.
  - Adaptive or manual video quality selection for both HLS (`.m3u8`) master playlists and DASH (`.mpd`) multi-representation manifests.
- **Combined Headers & Protection**:
  - Save custom request headers (such as `Referer`, `Origin`, `Authorization`, or custom token headers) per stream host (matching the host and its subdomains) for streams that otherwise return `403 Forbidden` errors.
  - Applied to HLS (`hls.js`), DASH (`dash.js`), FLV (`mpegts.js`), and Live MP4 (`fetch`) requests.
  - Enter a **License URL**, optional **License Request Headers**, and **Robustness Level** (e.g. `SW_SECURE_DECODE`, `SW_SECURE_CRYPTO`, `HW_SECURE_DECODE`) when an encrypted `.mpd` stream requires DRM.
  - Multi-line ClearKey key-pair configuration (`KID:KEY` pairs separated by commas or newlines).
  - Manifest KID verification to detect mismatched ClearKeys early and display clear error guidance.
- **Playback Controls**:
  - **Playback Speed Control**: YouTube-style speed popup offering a 0.5x–2.0x slider alongside quick presets (`1.0 Normal`, `1.25`, `1.5`, `2.0`).
  - **Picture-in-Picture (PiP)**: Toggle floating Picture-in-Picture playback.
  - **Web Fullscreen**: Expand video to cover the entire browser viewport without entering OS fullscreen.
  - **Save Screenshot**: Instant full-resolution PNG capture with auto-fading feedback (dimmed when capturing DRM-encrypted streams to prevent black frames).
- **Shareable Links**:
  - **Compact (`?z=…`)**: Default way of sharing URL
  - **Admin Only (`?s=<slug>`)**: Ultra-short preset links
  - **Safe Manual GitHub Sync**: Clicking **Copy shareable link** or **Copy** copies the link to your clipboard without automatically saving or committing to `streams.json`. You can modify the URL slug/alias name first, then click **Save to GitHub** when ready.
- **Default Dark Theme**: Clean, responsive dark interface with high-contrast playback controls.

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
