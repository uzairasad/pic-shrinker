# Changelog

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
