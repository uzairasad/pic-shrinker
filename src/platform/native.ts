/**
 * One place where the app talks to its host.
 *
 * In the desktop/mobile app (Tauri, `src-tauri/`) saving opens native dialogs and writes real
 * files, a whole batch goes straight into a folder you pick, and pictures opened from the OS
 * (command line, drag onto the app icon, a second launch) arrive here. In a browser it falls back
 * to the File System Access API (pick a folder, in Chromium browsers), or downloads.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { zipSync } from 'fflate';
import { PROJECT_LINKS, type ProjectLink } from '../appInfo';

export const isNativeApp = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const isMobile = (): boolean => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/**
 * The Android app is drawn edge to edge (behind the status bar and camera cutout, and the gesture
 * bar). Recent WebViews report that space as env(safe-area-inset-*); older ones report 0, which
 * put the top bar under the cutout. When the page fills the whole screen but no inset is
 * reported, reserve typical status bar and gesture bar heights instead.
 */
export function watchSafeArea() {
  if (!isNativeApp() || !/Android/i.test(navigator.userAgent)) return;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(probe);
  const update = () => {
    const cs = getComputedStyle(probe);
    const reported = parseFloat(cs.paddingTop) > 0 || parseFloat(cs.paddingBottom) > 0;
    // Edge to edge: the page is as tall as the screen (within a few pixels of rounding).
    const fullScreen = window.innerHeight >= screen.height - 4;
    const root = document.documentElement.style;
    root.setProperty('--safe-top-fallback', !reported && fullScreen ? '32px' : '0px');
    root.setProperty('--safe-bottom-fallback', !reported && fullScreen ? '20px' : '0px');
  };
  update();
  window.addEventListener('resize', update);
}

function browserDownload(fileName: string, data: Blob) {
  const href = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Saves one file. Returns its saved name, or null when the Save dialog was cancelled. */
export async function saveFile(fileName: string, data: ArrayBuffer | Uint8Array, mime: string): Promise<string | null> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!isNativeApp()) {
    browserDownload(fileName, new Blob([bytes as BlobPart], { type: mime }));
    return fileName;
  }
  const saved = await invoke<string | null>('save_file', bytes, {
    headers: { 'x-file-name': encodeURIComponent(fileName) },
  });
  return saved ? saved.split(/[\\/]/).pop() || fileName : null;
}

export interface OutputFile {
  /** Relative path, "/"-separated (may include sub-folders from a dropped folder). */
  path: string;
  bytes: ArrayBuffer;
}

export type SaveManyResult =
  | { kind: 'folder'; folder: string; count: number; native: boolean }
  | { kind: 'zip'; name: string | null; count: number }
  | { kind: 'cancelled' };

export const canPickFolder = (): boolean =>
  isNativeApp() ? !isMobile() : typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

/** Writes every file into a folder the user picks, or (where folders can't be picked) one ZIP. */
export async function saveMany(files: OutputFile[], zipName: string, preferZip = false): Promise<SaveManyResult> {
  if (!preferZip && canPickFolder()) {
    if (isNativeApp()) {
      const folder = await invoke<string | null>('pick_output_folder');
      if (!folder) return { kind: 'cancelled' };
      for (const f of files) {
        await invoke('write_output_file', new Uint8Array(f.bytes), {
          headers: { 'x-folder': encodeURIComponent(folder), 'x-file-name': encodeURIComponent(f.path) },
        });
      }
      return { kind: 'folder', folder, count: files.length, native: true };
    }
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({
        mode: 'readwrite',
        id: 'pic-shrinker-output',
      });
    } catch {
      return { kind: 'cancelled' };
    }
    for (const f of files) {
      const parts = f.path.split('/').filter(Boolean);
      let d = dir;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const name = await freeName(d, parts[parts.length - 1]);
      const handle = await d.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      await w.write(f.bytes);
      await w.close();
    }
    return { kind: 'folder', folder: dir.name, count: files.length, native: false };
  }
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  // Already-compressed images don't shrink further, so the ZIP just stores them.
  for (const f of files) entries[f.path] = [new Uint8Array(f.bytes), { level: 0 }];
  const zip = zipSync(entries);
  const name = await saveFile(zipName, zip, 'application/zip');
  return name ? { kind: 'zip', name, count: files.length } : { kind: 'cancelled' };
}

/** "photo.jpg", or "photo (2).jpg" if that already exists, so nothing is overwritten. */
async function freeName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 10_000; n++) {
    const candidate = n === 1 ? name : `${base} (${n})${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch {
      return candidate;
    }
  }
  return `${base}-${Date.now()}${ext}`;
}

/** Shows a folder the app saved into, in Explorer / Finder / the file manager. */
export async function revealFolder(folder: string) {
  if (isNativeApp()) await invoke('reveal_folder', { folder });
}

interface PendingFile {
  path: string;
  name: string;
}

async function drainPendingFiles(onFiles: (files: File[]) => void) {
  const pending = await invoke<PendingFile[]>('take_pending_files');
  const files: File[] = [];
  for (const { path, name } of pending) {
    try {
      const buffer = await invoke<ArrayBuffer>('read_document', { path });
      files.push(new File([buffer], name));
    } catch (err) {
      console.error('Could not open', path, err);
    }
  }
  if (files.length) onFiles(files);
}

/** Calls `onFiles` with pictures the OS hands the app (at launch and later). No-op in a browser. */
export function onFilesOpenedByOS(onFiles: (files: File[]) => void): () => void {
  if (!isNativeApp()) return () => {};
  let unlisten: (() => void) | undefined;
  let disposed = false;
  listen('pic-shrinker://open-files', () => void drainPendingFiles(onFiles)).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  void drainPendingFiles(onFiles);
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export async function openProjectLink(link: ProjectLink) {
  if (isNativeApp()) await invoke('open_project_link', { link });
  else window.open(PROJECT_LINKS[link], '_blank', 'noopener,noreferrer');
}
