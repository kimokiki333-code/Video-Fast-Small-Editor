# Make it Fast Edit Arsenal

**V3 light edition.** A full-scale, wide-desktop and mobile-ready video editing web application that runs entirely in the browser. No account, no backend, no upload: media stays on the device. The background is a tiny 2D canvas with a few drifting embers and one faint rotating wireframe ring — 20 fps, half resolution, stopped during playback. No WebGL and no Three.js.


## V3: split parts, undo/redo, light mode and 720p cap
- **Delete-able split parts** — add up to 24 parts. Every part has a **Remove / Restore** button; cut markers also offer **Del before / Del after**. Removed parts are skipped in both the MP4 and the split ZIP.
- **Edit each part** — focus any part with the **All parts / P1 / P2 / …** bar. All seven modules stay available; focused parts keep independent trim, crop, text, effects and output edits.
- **Undo / redo** — topbar buttons and `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, `Ctrl/Cmd+Y` cover every editing step, including per-part edits, cuts, deletes and output changes.
- **Light player** — a normal-resolution (DPR 1) 2D canvas redraws only on seek / edit / drag / resize when paused and at 25 fps during playback. The native media element still supplies audio.
- **Light background** — 8 drifts embers + one faint rotating wireframe ring, 20 fps, half resolution, plain Canvas 2D. It stops while video plays or the tab is hidden.
- **No heavy page effects** — blur composites, moving glows, scan lines, pulsing dots and endless animations are removed. The filmstrip loads later with only 8 thumbnails.
- **720p hard cap** — the Save quality dropdown offers **720p HD (default / max)**, **480p** and **360p**. A 1080p source exports at 1280×720, 852×480 or 640×360. Smaller sources are never scaled up.
- **Shapes** — Original, 16:9, 9:16, 1:1, 4:5, 4:3 or a custom ratio. Saved size is shape + quality; for example 9:16 at 720p is 720×1280.

## Working tools
- **Trim** — long dual-handle range bar under the video seek bar **plus** exact digital start/end timecode fields.
- **Crop** — free/manual draggable crop box with numeric X / Y / W / H; ratio presets are optional shortcuts, never a limitation.
- **Text** — multiple draggable text layers with font, size, color, outline, background, opacity, timing and position presets.
- **Splitter** — add split markers at the playhead, auto-split at intervals, preview segments and export a ZIP of real MP4 clips.
- **MP3 → MP4** — combine an audio file with an image or an auto-generated waveform cover.
- **Enhance** — rotate, flip, speed, volume/mute, brightness, contrast, saturation, gamma and watermark placement.
- **Extra tools** — PNG snapshot, MP3/WAV audio extraction, animated GIF and a 3×3 contact sheet.
- **Output** — custom canvas size, padding color, FPS and quality; MP4 export with live progress and cancel.

## Run locally
```bash
npm start
# http://localhost:4173
```
`server.mjs` is dependency-free and binds `0.0.0.0:4173` with the correct MIME/CORS headers.

## Deploy online
The folder is a static site. Upload the whole folder to Vercel, Netlify, Cloudflare Pages, GitHub Pages or any HTTPS host. `vercel.json`, `netlify.toml` and `_headers` are included. HTTPS (or localhost) is required for the service worker.

## Wrap as an Android APK
The PWA manifest, icons and service worker are ready. With Capacitor:
```bash
npm install
npm run cap:add:android
npm run cap:sync
npm run cap:open:android
```
Then build the APK in Android Studio. `capacitor.config.json` uses `https` as the Android scheme.

## Offline / local engine
The service worker precaches the full app shell **and** `engine/ffmpeg-core.wasm.gz`, so the first render can work offline. ffmpeg.wasm is single-thread `@ffmpeg/core@0.12.10` with `@ffmpeg/ffmpeg@0.12.15`; no SharedArrayBuffer, COOP/COEP or CDN is required. Short clips render fastest on phones.

## File map
```
index.html               Full application shell + SVG sprite
styles.css               Base responsive layout
blackout.css             Final black / cyan / lime / magenta design system
app.js                   State, editor interactions, exports
background.js            Tiny 2D ember + wireframe ring canvas
player.js                Normal-resolution 25 fps light preview renderer
ffmpeg-plan.js           Pure FFmpeg command builders
engine.js                Lazy local ffmpeg.wasm loader
media-utils.js           Canvas text/watermark/waveform/filmstrip helpers
zip.js                   Dependency-free store-only ZIP writer
sw.js                    Offline app-shell + engine cache (v3.0.0)
manifest.webmanifest     Installable PWA + tool shortcuts
server.mjs               Dependency-free static server
capacitor.config.json    Android APK wrapping config
```
All fonts, icons, the ffmpeg wrapper and the gzipped FFmpeg WASM are local. Licenses are in `LICENSES.md`.
