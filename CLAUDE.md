# Pic Shrinker — notes for Claude

Fast, private image compression by **Uzair Asad** (GitHub `uzairasad`). Free and open source,
GPL-3.0-or-later. One codebase ships a PWA (GitHub Pages `/app/`) and Tauri 2 native apps for
Windows, macOS, Linux and Android. README.md has the user-facing overview; this file is how to
work on it.

## Commands

```bash
npm install
npm run dev          # web app at http://localhost:3000 (fastest way to test UI + codecs)
npm run app:dev      # native window with hot reload (needs Rust + Tauri prerequisites)
npm run lint         # tsc --noEmit
npm test             # node --test on src/**/*.test.ts (metadata, naming, SSIM)
npm run build        # web build into dist/
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

Run lint, tests and (for Rust changes) fmt/clippy/test before committing; CI runs the same on
Windows, macOS and Linux. `cargo clippy` needs `dist/` to exist (run `npm run build` first).

## Map

| Path | What |
| --- | --- |
| `src/App.tsx` | State, job scheduling (settings version → recompress, selected item first), drag/drop/paste, save |
| `src/worker/compress.worker.ts` | Engine: decode → resize → encode → metadata → SSIM; target-size and auto quality search |
| `src/worker/decode.ts` | Sniffs bytes; browser decoders, jSquash, utif2 (TIFF), heic-to (HEIC) |
| `src/lib/pool.ts` | Worker pool (one per core, max 6), affinity so a worker keeps its decoded picture |
| `src/lib/metadata.ts` | Lossless JPEG EXIF/ICC copy, orientation reset, GPS removal (tested) |
| `src/lib/ssim.ts`, `format.ts`, `settings.ts`, `types.ts` | SSIM + proxy tiles, naming/sizes, presets/defaults, types |
| `src/components/` | CompareView (split viewer), SettingsPanel, FileList, EmptyState, About, `ui.tsx` primitives |
| `src/platform/native.ts` | Only place that talks to Tauri; falls back to browser APIs (File System Access, ZIP) |
| `src-tauri/src/lib.rs` | Rust commands: save_file, pick_output_folder, write_output_file, reveal_folder, open_project_link, CLI/OS-opened files |
| `site/index.html` | GitHub Pages landing page (download buttons resolve assets from the latest release) |
| `.github/workflows/` | ci.yml, pages.yml, release.yml |

## Things that bit before (keep them fixed)

- **React StrictMode**: state updaters run twice in dev. Never create/revoke object URLs or mutate
  results inside `setItems(fn)`; do side effects outside (see `applyResult`).
- The worker pool is an app-lifetime singleton (`getPool()`); don't dispose it in an effect.
- Codec packages (`@jsquash/*`) must stay in `optimizeDeps.exclude` or their `.wasm` files break.
- Tauri dialog `pick_folder` is desktop-only: keep it behind `#[cfg(desktop)]` (Android build fails otherwise). On mobile the UI saves batches as a ZIP.
- The webview has no fs permissions. Rust only writes inside folders the user picked
  (`OutputFolders.allowed`), never overwrites (`free_path`), and sanitises relative paths.
- MozJPEG extra trellis passes are off by default: they made encoding 2–3× slower.
- Large images: quality searches run on `proxyImage` (4 full-res tiles) first, then confirm.
- Settings are stored in localStorage under a versioned key (`pic-shrinker:settings:v2`); bump
  it when changing defaults that should override saved values.

## Style

- TypeScript strict, React function components, Tailwind 4 with CSS-variable theme tokens
  (`bg-panel`, `text-muted`, `brand`…) defined in `src/index.css` for light and dark.
- Comments explain *why*. User-facing text is plain English, British-ish spelling ("colour").
- Keep everything on-device: no analytics, no network calls besides the site's GitHub API fetch.

## Releasing

1. Bump `version` in `package.json` and `[workspace.package]` in `Cargo.toml`; add a CHANGELOG entry.
2. Commit, `git tag vX.Y.Z`, `git push origin main vX.Y.Z`.
3. `release.yml` builds all platforms, signs the APK (secrets `ANDROID_KEYSTORE_BASE64`,
   `ANDROID_KEYSTORE_PASSWORD`, alias `picshrinker`), uploads SHA256SUMS and publishes.
   Actions → Release → Run workflow with `android_only` is a quick APK-only check.

Commits are authored as `uzairasad <11199078+uzairasad@users.noreply.github.com>`.
