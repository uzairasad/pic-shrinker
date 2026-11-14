import type { ResizeMode, Settings } from './types.ts';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = Math.abs(bytes);
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : n < 10 ? 2 : n < 100 ? 1 : 0;
  return `${bytes < 0 ? '-' : ''}${n.toFixed(digits)} ${units[i]}`;
}

/** "−82%" for a smaller file, "+4%" for a larger one. */
export function formatSaving(before: number, after: number): string {
  if (!before) return '';
  const pct = Math.round((1 - after / before) * 100);
  if (pct === 0) return '0%';
  return pct > 0 ? `−${pct}%` : `+${-pct}%`;
}

/** Output size for a picture of `w`×`h` under the resize settings. */
export function targetDimensions(
  w: number,
  h: number,
  resize: Pick<Settings['resize'], 'mode' | 'width' | 'height' | 'percent' | 'noEnlarge'>,
): { width: number; height: number } {
  const mode: ResizeMode = resize.mode;
  let scale = 1;
  if (mode === 'fit') scale = Math.min(resize.width / w, resize.height / h);
  else if (mode === 'width') scale = resize.width / w;
  else if (mode === 'height') scale = resize.height / h;
  else if (mode === 'percent') scale = resize.percent / 100;
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  if (resize.noEnlarge) scale = Math.min(scale, 1);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Splits "photo.final.JPG" into ["photo.final", "JPG"]. */
export function splitName(fileName: string): [string, string] {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return [fileName, ''];
  return [fileName.slice(0, dot), fileName.slice(dot + 1)];
}

/**
 * The output file name for `fileName` under the naming pattern. Tokens: {name}, {ext} (original
 * extension), {w}, {h}, {q} (quality used), {n} (1-based index).
 */
export function outputName(
  pattern: string,
  fileName: string,
  extension: string,
  vars: { width: number; height: number; quality: number; index: number },
): string {
  const [base, ext] = splitName(fileName);
  const stem = (pattern || '{name}')
    .replaceAll('{name}', base)
    .replaceAll('{ext}', ext.toLowerCase())
    .replaceAll('{w}', String(vars.width))
    .replaceAll('{h}', String(vars.height))
    .replaceAll('{q}', String(Math.round(vars.quality)))
    .replaceAll('{n}', String(vars.index + 1))
    .replace(ILLEGAL, '_')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return `${stem || 'image'}.${extension}`;
}

/** Makes every name in `names` unique by adding " (2)", " (3)" … before the extension. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const key = name.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return name;
    const [base, ext] = splitName(name);
    let n = count + 1;
    let candidate = `${base} (${n})${ext ? `.${ext}` : ''}`;
    while (seen.has(candidate.toLowerCase())) {
      n++;
      candidate = `${base} (${n})${ext ? `.${ext}` : ''}`;
    }
    seen.set(candidate.toLowerCase(), 1);
    return candidate;
  });
}
