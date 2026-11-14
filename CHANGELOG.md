# Changelog

## 0.2.3 — 2026-11-14

- **Fixed: very large pictures came out with stripes of coloured noise.** A 500-megapixel
  panorama (31800×15900) saved with bands of noise across it. Each band of a large picture was
  encoded with cut-down code tables that could lack codes the band needed. Bands now get
  complete tables (files and speed are about the same), and the app checks every band before
  joining them, so a damaged band stops the job with an error instead of being saved. The
  similarity score for such pictures is right again too (it was dragged down by the damage).

## 0.2.2 — 2026-11-14

- **Fixed: large pictures failed with "Not enough memory" in the apps** (phone and desktop),
  even ones that fit easily. The parallel band helpers added in 0.2.1 were started from inside
  a background worker, which the system web engines the apps use don't allow, and the job
  then failed instead of carrying on. Helpers are now started by the app itself; any that can't
  start are skipped, and a band a helper can't compress is compressed by the job instead.
- Phones and low-memory devices use at most two helpers, to keep memory use down.
- **Fixed: on phones the top bar was hidden under the status bar and camera cutout.** The app
  now leaves room for them (and for the gesture bar), including on Android WebViews that don't
  report that space.

## 0.2.1 — 2026-11-14

- **Large maps compress 2–3× faster, more on machines with more cores.** A large picture's
  bands are now compressed on every core at once instead of one, while it is still being
  read. A 25000×20000 map took 141 s on 4 cores and now takes 64 s. Reading large JPEGs is
  about 25% faster too, and joining the bands does half the work. Files and quality are
  unchanged.

## 0.2.0 — 2026-11-14

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
