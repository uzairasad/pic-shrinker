/**
 * JPEG metadata: reads the EXIF (APP1) and ICC colour profile (APP2) segments from an original,
 * cleans the EXIF (orientation reset, GPS removed, pixel size updated) and writes them into a
 * freshly encoded JPEG. Pure functions over bytes, so they run in the worker and in tests.
 */

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const ICC_HEADER = 'ICC_PROFILE\0';

export interface JpegSegment {
  /** Marker byte after 0xFF, e.g. 0xE1 for APP1. */
  marker: number;
  payload: Uint8Array;
}

export interface JpegMetadata {
  exif?: Uint8Array;
  icc: Uint8Array[];
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** The segments before the image data (SOS), in file order. */
export function readSegments(bytes: Uint8Array): JpegSegment[] {
  const out: JpegSegment[] = [];
  if (!isJpeg(bytes)) return out;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) break;
    out.push({ marker, payload: bytes.subarray(i + 4, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}

function startsWith(payload: Uint8Array, prefix: ArrayLike<number> | string): boolean {
  const p = typeof prefix === 'string' ? [...prefix].map((c) => c.charCodeAt(0)) : prefix;
  if (payload.length < p.length) return false;
  for (let i = 0; i < p.length; i++) if (payload[i] !== p[i]) return false;
  return true;
}

export function readJpegMetadata(bytes: Uint8Array): JpegMetadata {
  const meta: JpegMetadata = { icc: [] };
  for (const seg of readSegments(bytes)) {
    if (seg.marker === 0xe1 && !meta.exif && startsWith(seg.payload, EXIF_HEADER)) {
      meta.exif = seg.payload.slice();
    } else if (seg.marker === 0xe2 && startsWith(seg.payload, ICC_HEADER)) {
      meta.icc.push(seg.payload.slice());
    }
  }
  return meta;
}

/** EXIF orientation 1–8 (1 when there is none). */
export function readOrientation(exif: Uint8Array | undefined): number {
  if (!exif) return 1;
  const t = tiff(exif);
  if (!t) return 1;
  const e = findEntry(t, t.ifd0, 0x0112);
  return e ? t.u16(e + 8) : 1;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

interface Tiff {
  view: DataView;
  /** Offset of the TIFF header within the EXIF payload. */
  base: number;
  le: boolean;
  ifd0: number;
  u16(off: number): number;
  u32(off: number): number;
  set16(off: number, v: number): void;
  set32(off: number, v: number): void;
  len: number;
}

function tiff(exif: Uint8Array): Tiff | null {
  if (!startsWith(exif, EXIF_HEADER) || exif.length < 14) return null;
  const view = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  const base = 6;
  const bo = view.getUint16(base);
  if (bo !== 0x4949 && bo !== 0x4d4d) return null;
  const le = bo === 0x4949;
  const len = exif.length - base;
  const t: Tiff = {
    view,
    base,
    le,
    ifd0: 0,
    len,
    // Offsets are relative to the TIFF header, as in the file.
    u16: (off) => view.getUint16(base + off, le),
    u32: (off) => view.getUint32(base + off, le),
    set16: (off, v) => view.setUint16(base + off, v, le),
    set32: (off, v) => view.setUint32(base + off, v, le),
  };
  if (t.u16(2) !== 42) return null;
  t.ifd0 = t.u32(4);
  if (t.ifd0 + 2 > len) return null;
  return t;
}

/** Offset of the 12-byte entry for `tag` in the IFD at `ifd`, or null. */
function findEntry(t: Tiff, ifd: number, tag: number): number | null {
  if (ifd + 2 > t.len) return null;
  const n = t.u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.len) return null;
    if (t.u16(e) === tag) return e;
  }
  return null;
}

function setDimension(t: Tiff, ifd: number, tag: number, value: number) {
  const e = findEntry(t, ifd, tag);
  if (e === null) return;
  const type = t.u16(e + 2);
  if (type === 3) t.set16(e + 8, Math.min(value, 0xffff));
  else if (type === 4) t.set32(e + 8, value);
}

/** Overwrites the GPS IFD (and the data it points at) with zeros and unlinks it from IFD0. */
function removeGps(t: Tiff, bytes: Uint8Array) {
  const ptr = findEntry(t, t.ifd0, 0x8825);
  if (ptr === null) return;
  const gps = t.u32(ptr + 8);
  if (gps + 2 <= t.len) {
    const n = t.u16(gps);
    for (let k = 0; k < n; k++) {
      const e = gps + 2 + k * 12;
      if (e + 12 > t.len) break;
      const size = (TYPE_SIZE[t.u16(e + 2)] ?? 1) * t.u32(e + 4);
      if (size > 4) {
        const off = t.u32(e + 8);
        if (off + size <= t.len) bytes.fill(0, t.base + off, t.base + off + size);
      }
    }
    bytes.fill(0, t.base + gps, Math.min(t.base + gps + 2 + n * 12 + 4, bytes.length));
  }
  // Drop the pointer entry: shift the later entries (and the next-IFD offset) up by 12 bytes.
  const n0 = t.u16(t.ifd0);
  const end = t.ifd0 + 2 + n0 * 12 + 4;
  bytes.copyWithin(t.base + ptr, t.base + ptr + 12, t.base + end);
  bytes.fill(0, t.base + end - 12, t.base + end);
  t.set16(t.ifd0, n0 - 1);
}

/**
 * A copy of `exif` that's right for the new file: orientation 1 (the pixels are already
 * upright), the new pixel size, and optionally no GPS location.
 */
export function cleanExif(
  exif: Uint8Array,
  opts: { removeGps: boolean; resetOrientation?: boolean; width?: number; height?: number },
): Uint8Array {
  const out = exif.slice();
  const t = tiff(out);
  if (!t) return out;
  const orient = findEntry(t, t.ifd0, 0x0112);
  if (orient !== null && opts.resetOrientation !== false) t.set16(orient + 8, 1);
  if (opts.width && opts.height) {
    const exifPtr = findEntry(t, t.ifd0, 0x8769);
    if (exifPtr !== null) {
      const sub = t.u32(exifPtr + 8);
      setDimension(t, sub, 0xa002, opts.width);
      setDimension(t, sub, 0xa003, opts.height);
    }
  }
  if (opts.removeGps) removeGps(t, out);
  return out;
}

/** Inserts `segments` into an encoded JPEG, after SOI and any JFIF APP0, dropping the JFIF if EXIF goes in. */
export function insertSegments(jpeg: Uint8Array, segments: JpegSegment[]): Uint8Array {
  const usable = segments.filter((s) => s.payload.length + 2 <= 0xffff);
  if (!usable.length || !isJpeg(jpeg)) return jpeg;
  let at = 2;
  // Keep a leading JFIF APP0 unless we're adding EXIF (EXIF files shouldn't carry JFIF too).
  const hasExif = usable.some((s) => s.marker === 0xe1);
  let skipFrom = -1;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) {
    const len = (jpeg[4] << 8) | jpeg[5];
    if (hasExif) skipFrom = 2;
    at = 2 + 2 + len;
  }
  const head = skipFrom >= 0 ? jpeg.subarray(0, skipFrom) : jpeg.subarray(0, at);
  const tail = jpeg.subarray(at);
  const extra = usable.reduce((n, s) => n + 4 + s.payload.length, 0);
  const out = new Uint8Array(head.length + extra + tail.length);
  out.set(head, 0);
  let o = head.length;
  for (const s of usable) {
    const len = s.payload.length + 2;
    out[o++] = 0xff;
    out[o++] = s.marker;
    out[o++] = len >> 8;
    out[o++] = len & 0xff;
    out.set(s.payload, o);
    o += s.payload.length;
  }
  out.set(tail, o);
  return out;
}

/**
 * Applies a metadata policy to an existing JPEG without re-encoding it (used when the original
 * is kept because it was already smaller). Orientation is left alone: the pixels aren't rotated.
 */
export function rewriteJpegMetadata(jpeg: Uint8Array, mode: 'strip' | 'icc' | 'nogps' | 'keep'): Uint8Array {
  if (!isJpeg(jpeg) || mode === 'keep') return jpeg;
  const parts: Uint8Array[] = [jpeg.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1];
    if (marker === 0xda) break;
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (len < 2 || i + 2 + len > jpeg.length) break;
    const seg = jpeg.subarray(i, i + 2 + len);
    const payload = seg.subarray(4);
    const isExif = marker === 0xe1 && startsWith(payload, EXIF_HEADER);
    const isIcc = marker === 0xe2 && startsWith(payload, ICC_HEADER);
    // APP1 (EXIF, XMP), APP2 (ICC, FlashPix), APP13 (IPTC), COM: personal or descriptive data.
    // APP0 (JFIF) and APP14 (Adobe colour transform) are needed to show the image correctly.
    const descriptive = marker === 0xe1 || marker === 0xe2 || marker === 0xed || marker === 0xfe;
    if (!descriptive) parts.push(seg);
    else if (isIcc && mode !== 'strip') parts.push(seg);
    else if (isExif && mode === 'nogps') {
      const clean = cleanExif(payload, { removeGps: true, resetOrientation: false });
      const head = new Uint8Array([0xff, 0xe1, (clean.length + 2) >> 8, (clean.length + 2) & 0xff]);
      parts.push(head, clean);
    }
    i += 2 + len;
  }
  parts.push(jpeg.subarray(i));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
