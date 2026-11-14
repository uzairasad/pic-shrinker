/** Turns any supported image file into RGBA pixels, upright. Runs inside the worker. */

export type SourceKind = 'jpeg' | 'png' | 'webp' | 'gif' | 'bmp' | 'avif' | 'heic' | 'tiff' | 'jxl' | 'unknown';

/** Formats an <img> element can't be relied on to show, on every platform. */
export const NEEDS_PREVIEW: SourceKind[] = ['heic', 'tiff', 'jxl'];

function ascii(b: Uint8Array, start: number, len: number) {
  return String.fromCharCode(...b.subarray(start, start + len));
}

/** Identifies a file by its first bytes, not its name. */
export function sniff(b: Uint8Array): SourceKind {
  if (b.length < 12) return 'unknown';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (ascii(b, 0, 3) === 'GIF') return 'gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return 'tiff';
  if ((b[0] === 0xff && b[1] === 0x0a) || ascii(b, 4, 4) === 'JXL ') return 'jxl';
  if (ascii(b, 4, 4) === 'ftyp') {
    const size = Math.min(b.length, (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]);
    const brands: string[] = [];
    for (let i = 8; i + 4 <= size; i += 4) if (i !== 12) brands.push(ascii(b, i, 4));
    if (brands.some((x) => x === 'avif' || x === 'avis')) return 'avif';
    if (brands.some((x) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(x))) return 'heic';
  }
  return 'unknown';
}

function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function viaBrowser(blob: Blob, keepColors: boolean): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'from-image',
    premultiplyAlpha: 'none',
    // When the colour profile goes into the output, keep the pixel values as they are.
    colorSpaceConversion: keepColors ? 'none' : 'default',
  });
  return bitmapToImageData(bitmap);
}

async function viaTiff(buffer: ArrayBuffer): Promise<ImageData> {
  const { default: UTIF } = await import('utif2');
  const ifds = UTIF.decode(buffer);
  // The largest page is the picture; the others are usually thumbnails.
  const area = (ifd: (typeof ifds)[number]) =>
    (Number((ifd.t256 as number[] | undefined)?.[0]) || 0) * (Number((ifd.t257 as number[] | undefined)?.[0]) || 0);
  const page = ifds.reduce((best, ifd) => (area(ifd) > area(best) ? ifd : best), ifds[0]);
  UTIF.decodeImage(buffer, page);
  const rgba = UTIF.toRGBA8(page);
  return new ImageData(new Uint8ClampedArray(rgba), page.width, page.height);
}

export interface Decoded {
  image: ImageData;
  kind: SourceKind;
}

export async function decodeFile(file: Blob, keepColors: boolean): Promise<Decoded> {
  const buffer = await file.arrayBuffer();
  const kind = sniff(new Uint8Array(buffer));
  switch (kind) {
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'bmp':
      return { kind, image: await viaBrowser(file, keepColors) };
    case 'webp':
      try {
        return { kind, image: await viaBrowser(file, keepColors) };
      } catch {
        const { default: decode } = await import('@jsquash/webp/decode.js');
        return { kind, image: await decode(buffer) };
      }
    case 'avif':
      try {
        return { kind, image: await viaBrowser(file, keepColors) };
      } catch {
        const { default: decode } = await import('@jsquash/avif/decode.js');
        const image = await decode(buffer);
        if (!image) throw new Error('This AVIF file could not be read.');
        return { kind, image };
      }
    case 'jxl': {
      const { default: decode } = await import('@jsquash/jxl/decode.js');
      return { kind, image: await decode(buffer) };
    }
    case 'tiff':
      return { kind, image: await viaTiff(buffer) };
    case 'heic': {
      const { heicTo } = await import('heic-to/csp');
      const bitmap = await heicTo({ blob: file, type: 'bitmap', options: { imageOrientation: 'from-image' } });
      return { kind, image: bitmapToImageData(bitmap) };
    }
    default:
      // Last try: whatever the browser engine understands (e.g. ICO, SVG is not supported here).
      try {
        return { kind, image: await viaBrowser(file, keepColors) };
      } catch {
        throw new Error('Not a supported image format.');
      }
  }
}

/** Decodes bytes this app just encoded (for measuring quality). */
export async function decodeEncoded(bytes: ArrayBuffer, format: string): Promise<ImageData> {
  switch (format) {
    case 'jpeg': {
      const { default: decode } = await import('@jsquash/jpeg/decode.js');
      return decode(bytes);
    }
    case 'webp': {
      const { default: decode } = await import('@jsquash/webp/decode.js');
      return decode(bytes);
    }
    case 'avif': {
      const { default: decode } = await import('@jsquash/avif/decode.js');
      const img = await decode(bytes);
      if (!img) throw new Error('AVIF decode failed');
      return img;
    }
    default: {
      const { default: decode } = await import('@jsquash/png/decode.js');
      return decode(bytes);
    }
  }
}
