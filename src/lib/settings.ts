import type { Settings } from './types.ts';

export const defaultSettings: Settings = {
  format: 'original',
  mode: 'quality',
  quality: 78,
  targetKB: 200,
  autoTarget: 0.985,
  resize: {
    mode: 'none',
    width: 1920,
    height: 1920,
    percent: 50,
    method: 'lanczos3',
    noEnlarge: true,
  },
  metadata: 'strip',
  background: '#ffffff',
  neverLarger: true,
  naming: '{name}',
  jpeg: {
    progressive: true,
    chromaSubsample: 2,
    autoSubsample: true,
    smoothing: 0,
    quantTable: 3,
    trellis: false,
    grayscale: false,
    separateChromaQuality: false,
    chromaQuality: 75,
  },
  webp: { effort: 4, lossless: false, nearLossless: 100, sharpYuv: true },
  avif: { speed: 6, subsample: 1, lossless: false },
  png: { level: 2, interlace: false },
};

export interface Preset {
  id: string;
  label: string;
  hint: string;
  apply: (s: Settings) => Settings;
}

export const presets: Preset[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    hint: 'Same format, quality 78, metadata removed',
    apply: () => structuredClone(defaultSettings),
  },
  {
    id: 'lossless-look',
    label: 'Looks identical',
    hint: 'Finds the smallest file that still looks the same (SSIM ≥ 0.985)',
    apply: (s) => ({ ...s, mode: 'auto', autoTarget: 0.985 }),
  },
  {
    id: 'web',
    label: 'Website',
    hint: 'WebP, up to 1920 px, quality 75',
    apply: (s) => ({
      ...s,
      format: 'webp',
      mode: 'quality',
      quality: 75,
      metadata: 'strip',
      resize: { ...s.resize, mode: 'fit', width: 1920, height: 1920, noEnlarge: true },
    }),
  },
  {
    id: 'email',
    label: 'Email',
    hint: 'JPEG under 250 KB, up to 1600 px',
    apply: (s) => ({
      ...s,
      format: 'jpeg',
      mode: 'size',
      targetKB: 250,
      metadata: 'strip',
      resize: { ...s.resize, mode: 'fit', width: 1600, height: 1600, noEnlarge: true },
    }),
  },
  {
    id: 'smallest',
    label: 'Smallest',
    hint: 'AVIF, quality 50',
    apply: (s) => ({ ...s, format: 'avif', mode: 'quality', quality: 50, metadata: 'strip' }),
  },
  {
    id: 'archive',
    label: 'Photo archive',
    hint: 'JPEG quality 88, 4:4:4 colour, EXIF kept without GPS',
    apply: (s) => ({
      ...s,
      format: 'jpeg',
      mode: 'quality',
      quality: 88,
      metadata: 'nogps',
      jpeg: { ...s.jpeg, chromaSubsample: 1, autoSubsample: false },
    }),
  },
];

const STORAGE_KEY = 'pic-shrinker:settings:v2';

/** Merges saved settings over the defaults, so settings added in later versions get defaults. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultSettings);
    const saved = JSON.parse(raw) as Partial<Settings>;
    return {
      ...defaultSettings,
      ...saved,
      resize: { ...defaultSettings.resize, ...saved.resize },
      jpeg: { ...defaultSettings.jpeg, ...saved.jpeg },
      webp: { ...defaultSettings.webp, ...saved.webp },
      avif: { ...defaultSettings.avif, ...saved.avif },
      png: { ...defaultSettings.png, ...saved.png },
    };
  } catch {
    return structuredClone(defaultSettings);
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Private mode or storage full: settings just aren't remembered.
  }
}
