# Third-party notices

Pic Shrinker is © 2026 Uzair Asad and licensed under the
[GNU General Public License v3.0 or later](LICENSE). It includes the following third-party
work, each under its own license.

## Image codecs (WebAssembly)

Built for the web by the [Squoosh](https://github.com/GoogleChromeLabs/squoosh) project and
packaged as [jSquash](https://github.com/jamsinclair/jSquash) (Apache-2.0).

| Codec | Used for | License |
| --- | --- | --- |
| [MozJPEG](https://github.com/mozilla/mozjpeg) | JPEG encoding and decoding | IJG / BSD-3-Clause / zlib |
| [libwebp](https://chromium.googlesource.com/webm/libwebp) | WebP encoding and decoding | BSD-3-Clause |
| [libavif](https://github.com/AOMediaCodec/libavif) with [libaom](https://aomedia.googlesource.com/aom/) | AVIF encoding and decoding | BSD-2-Clause / BSD-3-Clause (AOM patent license) |
| [OxiPNG](https://github.com/shssoichiro/oxipng) | Lossless PNG optimisation | MIT |
| [libpng](http://www.libpng.org/pub/png/libpng.html) / [png crate](https://github.com/image-rs/image-png) | PNG decoding | libpng / MIT or Apache-2.0 |
| [libjxl](https://github.com/libjxl/libjxl) | JPEG XL decoding | BSD-3-Clause |
| Squoosh resize ([resize crate](https://github.com/PistonDevelopers/resize)), Magic Kernel | Lanczos and other resampling | MIT / Apache-2.0 |

## Other libraries

| Library | Used for | License |
| --- | --- | --- |
| [heic-to](https://github.com/hoppergee/heic-to) with [libheif](https://github.com/strukturag/libheif) and [libde265](https://github.com/strukturag/libde265) | Reading HEIC / HEIF photos | LGPL-3.0 |
| [UTIF.js](https://github.com/photopea/UTIF.js) (utif2) | Reading TIFF | MIT |
| [fflate](https://github.com/101arrowz/fflate) | ZIP downloads | MIT |
| [React](https://react.dev) | User interface | MIT |
| [Tauri](https://tauri.app) (Rust crates and `@tauri-apps/api`) | Native apps | MIT or Apache-2.0 |
| [Lucide](https://lucide.dev) icons | Icons | ISC |
| [Workbox](https://developer.chrome.com/docs/workbox) (via vite-plugin-pwa) | Offline web app | MIT |

## Fonts

| Font | License |
| --- | --- |
| [Inter](https://rsms.me/inter/) (through [Fontsource](https://fontsource.org)) | SIL Open Font License 1.1 |

The complete list of JavaScript and Rust dependencies, with their versions, is in
`package-lock.json` and `Cargo.lock`. Each package's license ships with it.
