import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Set by the Tauri CLI when it builds or runs the desktop/mobile app (src-tauri/).
const isNativeApp = Boolean(process.env.TAURI_ENV_PLATFORM);
// Where the web app is served from: '/' normally, '/<repo>/app/' on GitHub Pages.
const base = process.env.BASE_PATH || '/';

// The WebAssembly codecs are loaded on demand; Vite must not pre-bundle them (it would lose the .wasm files).
const codecs = ['@jsquash/jpeg', '@jsquash/webp', '@jsquash/avif', '@jsquash/png', '@jsquash/oxipng', '@jsquash/resize', '@jsquash/jxl'];

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: !isNativeApp,
  plugins: [
    react(),
    tailwindcss(),
    // No service worker in the native app: its files are already local.
    !isNativeApp &&
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'icon.svg'],
        manifest: {
          id: './',
          name: 'Pic Shrinker',
          short_name: 'Pic Shrinker',
          description: 'Fast, private image compression by Uzair Asad. MozJPEG, WebP, AVIF and OxiPNG on your own device. Works offline.',
          theme_color: '#0b0c11',
          background_color: '#0b0c11',
          display: 'standalone',
          start_url: './',
          scope: './',
          categories: ['photo', 'productivity', 'utilities'],
          icons: [
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
          // Lets "Open with" / share-to on installed PWAs hand pictures to the app (Chromium).
          file_handlers: [
            {
              action: './',
              accept: {
                'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp', '.heic', '.heif', '.tif', '.tiff', '.jxl'],
              },
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,wasm}'],
          // The HEIC decoder is large; it is cached the first time it's used instead.
          // Skipped: the multi-threaded AVIF build (needs cross-origin isolation, which isn't on) and
          // the pixel-art scaler (never used).
          globIgnores: ['**/heic-to-*.js', '**/*_mt*', '**/squooshhqx*'],
          maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
          runtimeCaching: [
            {
              urlPattern: /heic-to-.*\.js$/,
              handler: 'CacheFirst',
              options: { cacheName: 'heic-decoder', expiration: { maxEntries: 4 } },
            },
          ],
        },
        devOptions: { enabled: false },
      }),
  ],
  optimizeDeps: { exclude: codecs },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
  server: {
    // Tauri loads exactly devUrl (port 3000), so never drift to another port.
    strictPort: isNativeApp,
  },
});
