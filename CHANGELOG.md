# Changelog

## Unreleased

- **Very large JPEGs work.** Maps, scans and panoramas over 64 megapixels (tested at
  20000×14000, 84 MB) used to fail with "Aborted()": the encoder ran out of memory. They are now
  decoded, resized and encoded a band of rows at a time and joined into one JPEG, so memory use
  stays low whatever the size. Large results are saved as baseline (not progressive) JPEG; to
  save one as WebP, AVIF or PNG, resize it under 64 megapixels first (the app says so).
- **Updates from inside the app.** About → Check for updates. The desktop apps download, verify
  (signed), install and restart; the portable Windows copy, Linux .deb/.rpm and Android open the
  download instead; the web app reloads into the new version. Installed apps also check quietly
  at start-up, at most once a day (can be turned off in About).
- **Fits the screen at high display scaling.** The window is sized to the monitor's work area
  at launch (it used to open taller than a 1080p screen at 150%), its minimum size is smaller,
  and short windows get a compact layout instead of cut-off content.
- Out-of-memory errors now read as plain English, and the worker that hit one is replaced so
  the next picture isn't affected. A replaced worker no longer leaves its next job hanging.

## 0.1.0 — 2026-11-14

First release.

- Compress JPEG (MozJPEG), WebP, AVIF and PNG (OxiPNG), or convert between them. Reads JPEG,
  PNG, WebP, AVIF, HEIC/HEIF, TIFF, BMP, GIF and JPEG XL.
- Live before/after comparison: drag the divider, zoom up to 1600% with pixel-accurate
  rendering, hold Space to see the original. Every result gets an SSIM similarity score.
- Three ways to compress: a quality slider, a **target file size** (the best quality that
  fits), or **Auto**, which finds the smallest file that still looks like the original.
- Resize by longest side, width, height or percentage with Lanczos3, Magic Kernel Sharp,
  Mitchell, Catmull-Rom or bilinear resampling.
- Metadata control: remove everything, keep only the colour profile, keep EXIF without the GPS
  location, or keep it all. EXIF orientation is applied to the pixels, so pictures stay upright.
- Advanced JPEG options: progressive, chroma subsampling, smoothing, quantization tables,
  extra trellis passes, grayscale, separate colour quality, background for transparency.
- "Never larger than original": already-optimised files are kept (with metadata cleaned).
- Batch: drop pictures or whole folders (structure is kept), or paste from the clipboard.
  Pictures compress in parallel on every CPU core. Save everything into a folder (never
  overwriting) or as a ZIP. Name patterns such as `{name}-min` or `{name}-{w}px`.
- Presets: Balanced, Looks identical, Website, Email, Smallest, Photo archive.
- Native apps for Windows, macOS, Linux and Android, and an installable offline web app.
  Nothing is ever uploaded.
