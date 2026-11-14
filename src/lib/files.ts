/** Collecting pictures from file pickers, folder drops and the clipboard. */

const EXTENSIONS = ['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'jxl'];

export const ACCEPT = EXTENSIONS.map((e) => `.${e}`).join(',') + ',image/*';

export function isImageFile(f: File): boolean {
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSIONS.includes(ext) || (f.type.startsWith('image/') && f.type !== 'image/svg+xml');
}

export interface PickedFile {
  file: File;
  relativePath: string;
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry: FileSystemEntry, out: PickedFile[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    if (isImageFile(file)) out.push({ file, relativePath: entry.fullPath.replace(/^\//, '') });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most ~100 entries per call.
    for (;;) {
      const batch = await readEntries(reader);
      if (!batch.length) break;
      for (const e of batch) await walk(e, out);
    }
  }
}

/** Files (and the contents of folders, recursively) from a drop. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const entries = [...dt.items]
    .filter((i) => i.kind === 'file')
    .map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  if (entries.length && entries.every(Boolean)) {
    for (const e of entries) await walk(e!, out);
    return out;
  }
  for (const f of dt.files) if (isImageFile(f)) out.push({ file: f, relativePath: f.name });
  return out;
}

export function filesFromInput(list: FileList | null): PickedFile[] {
  return [...(list ?? [])]
    .filter(isImageFile)
    .map((file) => ({ file, relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }));
}

/** Pasted images get a readable name instead of "image.png". */
export function filesFromClipboard(e: ClipboardEvent): PickedFile[] {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return [...(e.clipboardData?.files ?? [])].filter(isImageFile).map((f, i) => {
    const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const name = f.name && f.name !== 'image.png' ? f.name : `Pasted ${stamp}${i ? `-${i + 1}` : ''}.${ext}`;
    const file = new File([f], name, { type: f.type });
    return { file, relativePath: name };
  });
}
