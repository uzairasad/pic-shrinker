/// <reference lib="webworker" />
/**
 * The compression engine. One instance per CPU core (see src/lib/pool.ts). For each job it
 * decodes the original, resizes it, encodes it with the chosen codec (searching for a quality
 * in target-size and auto modes), restores metadata, and measures SSIM against the original.
 */
import { targetDimensions } from '../lib/format.ts';
import { cleanExif, insertSegments, readJpegMetadata, readOrientation, rewriteJpegMetadata, type JpegSegment } from '../lib/metadata.ts';
import { proxyImage, ssim } from '../lib/ssim.ts';
import type { CompressResult, EncodableFormat, Settings } from '../lib/types.ts';
import { decodeEncoded, decodeFile, NEEDS_PREVIEW, type Decoded, type SourceKind } from './decode.ts';
import { bisectForSize, encode, isLossless, lookQuality, RANGE } from './encode.ts';
import {
  compressLarge,
  LARGE_PIXELS,
  largeJpegInfo,
  largeSource,
  orientationExif,
  orientImage,
  readWhole,
  swapsSides,
  type LargeSource,
} from './large.ts';

export interface JobRequest {
  jobId: number;
  itemId: string;
  file: File;
  settings: Settings;
  wantThumb: boolean;
  wantPreview: boolean;
  /** Cores this job may use for a large picture's bands (the pool divides them between jobs). */
  threads?: number;
}

export type JobResponse =
  | { jobId: number; ok: true; result: CompressResult }
  | { jobId: number; ok: false; error: string; fatal?: boolean };

const MIME: Record<EncodableFormat, string> = {
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  png: 'image/png',
};
const EXT: Record<EncodableFormat, string> = { jpeg: 'jpg', webp: 'webp', avif: 'avif', png: 'png' };

/** What "keep original format" means for each input. */
function resolveFormat(s: Settings, kind: SourceKind): EncodableFormat {
  if (s.format !== 'original') return s.format;
  switch (kind) {
    case 'png':
    case 'gif':
    case 'bmp':
      return 'png';
    case 'webp':
      return 'webp';
    case 'avif':
      return 'avif';
    default:
      return 'jpeg';
  }
}

// A couple of decoded originals, so moving a slider doesn't decode the same file again.
const cache = new Map<string, { file: File; keepColors: boolean; decoded: Decoded }>();

async function decodeCached(itemId: string, file: File, keepColors: boolean): Promise<Decoded> {
  const hit = cache.get(itemId);
  if (hit && hit.file === file && hit.keepColors === keepColors) {
    cache.delete(itemId);
    cache.set(itemId, hit);
    return hit.decoded;
  }
  const decoded = await decodeFile(file, keepColors);
  cache.set(itemId, { file, keepColors, decoded });
  while (cache.size > 2) cache.delete(cache.keys().next().value!);
  return decoded;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hasAlpha(img: ImageData): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/** JPEG has no transparency: composite onto the background colour. */
function flatten(img: ImageData, background: string): ImageData {
  if (!hasAlpha(img)) return img;
  const [br, bg, bb] = hexToRgb(background);
  const out = new Uint8ClampedArray(img.data.length);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = d[i] * a + br * (1 - a);
    out[i + 1] = d[i + 1] * a + bg * (1 - a);
    out[i + 2] = d[i + 2] * a + bb * (1 - a);
    out[i + 3] = 255;
  }
  return new ImageData(out, img.width, img.height);
}

/** Highest quality whose file fits in `targetBytes`. */
async function searchForSize(fmt: EncodableFormat, img: ImageData, s: Settings, targetBytes: number) {
  const [min, max] = RANGE[fmt];
  const proxy = proxyImage(img, (d, w, h) => new ImageData(d as Uint8ClampedArray<ArrayBuffer>, w, h));
  if (proxy !== img) {
    // Big picture: find the quality on the proxy (file size scales with area), then confirm on
    // the real thing and step down until it fits. Usually 1–3 full-size encodes instead of 7.
    const scaledTarget = (targetBytes * proxy.width * proxy.height) / (img.width * img.height);
    const guess = (await bisectForSize(fmt, proxy, s, scaledTarget, min, max)).best?.quality ?? min;
    let q = guess;
    let bytes = await encode(fmt, img, s, q);
    let fitted: { bytes: ArrayBuffer; quality: number } | null = bytes.byteLength <= targetBytes ? { bytes, quality: q } : null;
    if (fitted) {
      // Room to spare: try a step up.
      for (let up = q + 3; up <= max && bytes.byteLength < targetBytes * 0.9; up += 3) {
        const b = await encode(fmt, img, s, up);
        if (b.byteLength > targetBytes) break;
        fitted = { bytes: b, quality: up };
        bytes = b;
      }
      return fitted;
    }
    for (let tries = 0; tries < 5 && q > min; tries++) {
      q = Math.max(min, q - (tries < 2 ? 4 : 8));
      bytes = await encode(fmt, img, s, q);
      if (bytes.byteLength <= targetBytes) return { bytes, quality: q };
    }
    // Fall through to the exact search below the last tried quality.
    const { best, smallest } = await bisectForSize(fmt, img, s, targetBytes, min, q);
    if (best) return best;
    return lowest(fmt, img, s, smallest);
  }
  const { best, smallest } = await bisectForSize(fmt, img, s, targetBytes, min, max);
  return best ?? lowest(fmt, img, s, smallest);
}

/** Even the bottom of the range is too big: try the very lowest quality. */
async function lowest(fmt: EncodableFormat, img: ImageData, s: Settings, smallest: { bytes: ArrayBuffer; quality: number }) {
  const q = Math.max(1, RANGE[fmt][0] - 9);
  const bytes = await encode(fmt, img, s, q);
  return bytes.byteLength < smallest.bytes.byteLength ? { bytes, quality: q } : smallest;
}

/** Lowest quality whose SSIM (on a proxy of the picture) reaches `target`. */
async function searchForLook(fmt: EncodableFormat, img: ImageData, s: Settings, target: number) {
  const proxy = proxyImage(img, (d, w, h) => new ImageData(d as Uint8ClampedArray<ArrayBuffer>, w, h));
  const quality = await lookQuality(fmt, proxy, s, target);
  return { quality, bytes: await encode(fmt, img, s, quality) };
}

async function jpegPreview(img: ImageData, maxSide: number, quality: number): Promise<ArrayBuffer> {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const full = new OffscreenCanvas(img.width, img.height);
  full.getContext('2d')!.putImageData(img, 0, 0);
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, w, h);
  const blob = await out.convertToBlob({ type: 'image/jpeg', quality });
  return blob.arrayBuffer();
}

async function run(req: JobRequest): Promise<CompressResult> {
  const t0 = performance.now();
  const s = req.settings;
  const head = new Uint8Array(await req.file.slice(0, 64).arrayBuffer());
  const isJpegSource = head[0] === 0xff && head[1] === 0xd8;
  const wantsJpegOut = s.format === 'jpeg' || (s.format === 'original' && isJpegSource);
  // Metadata is carried JPEG → JPEG. Then the colour profile goes along, so pixels stay unconverted.
  const carryMeta = isJpegSource && wantsJpegOut && s.metadata !== 'strip';

  let source: ImageData;
  let kind: SourceKind;
  let img: ImageData;
  let resized: boolean;
  /** Large JPEGs are decoded by our own decoder: as stored (not turned upright), no colour management. */
  let large: { orientation: number; data: Uint8Array } | null = null;
  const largeInfo = isJpegSource ? await largeJpegInfo(req.file) : null;
  if (largeInfo) {
    const data = new Uint8Array(await req.file.arrayBuffer());
    const orientation = readOrientation(readJpegMetadata(data).exif);
    large = { orientation, data };
    const swap = swapsSides(orientation);
    const upright = swap ? { width: largeInfo.height, height: largeInfo.width } : largeInfo;
    const dims = targetDimensions(upright.width, upright.height, s.resize);
    resized = dims.width !== upright.width || dims.height !== upright.height;
    // The decoder (and its resizer) work on the picture as stored; it's turned afterwards.
    const src = largeSource(data, swap ? dims.height : dims.width, swap ? dims.width : dims.height);
    if (dims.width * dims.height > LARGE_PIXELS) {
      return runLarge(req, src, { ...large, upright, dims, resized, t0 });
    }
    // Small enough once resized: shrunk while decoding, then the normal pipeline.
    img = orientImage(readWhole(src), orientation);
    source = img;
    kind = 'jpeg';
  } else {
    ({ image: source, kind } = await decodeCached(req.itemId, req.file, carryMeta));
    const dims = targetDimensions(source.width, source.height, s.resize);
    resized = dims.width !== source.width || dims.height !== source.height;
    img = source;
    if (resized) {
      const { default: resize } = await import('@jsquash/resize');
      img = await resize(source, {
        width: dims.width,
        height: dims.height,
        method: s.resize.method,
        fitMethod: 'stretch',
        premultiply: true,
        linearRGB: true,
      });
    }
  }
  const fmt = resolveFormat(s, kind);
  const sourceWidth = largeInfo ? (swapsSides(large!.orientation) ? largeInfo.height : largeInfo.width) : source.width;
  const sourceHeight = largeInfo ? (swapsSides(large!.orientation) ? largeInfo.width : largeInfo.height) : source.height;
  if (fmt === 'jpeg') img = flatten(img, s.background);

  let bytes: ArrayBuffer;
  let quality = s.quality;
  if (fmt === 'png' && kind === 'png' && !resized) {
    // Lossless and keeps the original bit depth.
    const { default: optimise } = await import('@jsquash/oxipng/optimise.js');
    bytes = await optimise(await req.file.arrayBuffer(), { level: s.png.level, interlace: s.png.interlace, optimiseAlpha: true });
    quality = 100;
  } else if (isLossless(fmt, s)) {
    bytes = await encode(fmt, img, s, 100);
    quality = 100;
  } else if (s.mode === 'size') {
    ({ bytes, quality } = await searchForSize(fmt, img, s, s.targetKB * 1024));
  } else if (s.mode === 'auto') {
    ({ bytes, quality } = await searchForLook(fmt, img, s, s.autoTarget));
  } else {
    bytes = await encode(fmt, img, s, s.quality);
  }

  // Large pictures' pixels weren't colour-converted, so their profile always goes along.
  if (fmt === 'jpeg' && (carryMeta || large)) {
    const meta = readJpegMetadata(new Uint8Array(await req.file.arrayBuffer()));
    const segments: JpegSegment[] = [];
    if (meta.exif && carryMeta && (s.metadata === 'keep' || s.metadata === 'nogps')) {
      segments.push({
        marker: 0xe1,
        payload: cleanExif(meta.exif, { removeGps: s.metadata === 'nogps', width: img.width, height: img.height }),
      });
    }
    for (const icc of meta.icc) segments.push({ marker: 0xe2, payload: icc });
    if (segments.length) {
      const withMeta = insertSegments(new Uint8Array(bytes), segments);
      bytes = withMeta.buffer.slice(withMeta.byteOffset, withMeta.byteOffset + withMeta.byteLength) as ArrayBuffer;
    }
  }

  // Already-optimised originals can come out bigger; then keep the original (cleaned, for JPEG).
  let keptOriginal = false;
  const sameFormat = fmt === kind || (fmt === 'png' && kind === 'png');
  if (s.neverLarger && sameFormat && !resized && bytes.byteLength >= req.file.size) {
    let original = new Uint8Array(await req.file.arrayBuffer());
    if (kind === 'jpeg') original = rewriteJpegMetadata(original, s.metadata) as Uint8Array<ArrayBuffer>;
    bytes = original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength) as ArrayBuffer;
    keptOriginal = true;
  }

  // Quality score of the file as it will be saved, compared with the resized original.
  let score = 1;
  const exact = isLossless(fmt, s) && !(fmt === 'webp' && s.webp.nearLossless < 100);
  if (!keptOriginal && !exact) {
    try {
      const back = await decodeEncoded(bytes, fmt);
      if (back.width === img.width && back.height === img.height) score = ssim(img, back);
    } catch {
      score = NaN;
    }
  }

  const result: CompressResult = {
    bytes,
    mime: MIME[fmt],
    extension: kind === 'jpeg' && fmt === 'jpeg' && /\.jpe?g$/i.test(req.file.name) ? req.file.name.split('.').pop()!.toLowerCase() : EXT[fmt],
    width: img.width,
    height: img.height,
    sourceWidth,
    sourceHeight,
    quality,
    ssim: score,
    keptOriginal,
    ms: Math.round(performance.now() - t0),
  };
  if (req.wantThumb) result.thumb = await jpegPreview(source, 192, 0.8);
  if (req.wantPreview && NEEDS_PREVIEW.includes(kind)) result.originalPreview = await jpegPreview(source, 4096, 0.92);
  return result;
}

const FORMAT_NAME: Record<EncodableFormat, string> = { jpeg: 'JPEG', webp: 'WebP', avif: 'AVIF', png: 'PNG' };

/** A large JPEG whose result is large too: encoded in bands, never held whole (see large.ts). */
async function runLarge(
  req: JobRequest,
  src: LargeSource,
  o: {
    orientation: number;
    data: Uint8Array;
    upright: { width: number; height: number };
    dims: { width: number; height: number };
    resized: boolean;
    t0: number;
  },
): Promise<CompressResult> {
  const s = req.settings;
  const fmt = resolveFormat(s, 'jpeg');
  if (fmt !== 'jpeg') {
    const mp = Math.floor(LARGE_PIXELS / 1e6);
    throw new Error(
      `This picture (${o.dims.width}×${o.dims.height}) is too large to save as ${FORMAT_NAME[fmt]}. Choose JPEG, or resize it to under ${mp} megapixels.`,
    );
  }
  const out = await compressLarge(src, s, req.wantThumb, req.threads ?? 1);
  let bytes: Uint8Array = out.bytes;

  // Metadata. The pixels are as stored (not turned upright, not colour-converted), so the
  // orientation and colour profile must go along whatever the setting.
  const meta = readJpegMetadata(o.data);
  const segments: JpegSegment[] = [];
  if (meta.exif && (s.metadata === 'keep' || s.metadata === 'nogps')) {
    segments.push({
      marker: 0xe1,
      payload: cleanExif(meta.exif, { removeGps: s.metadata === 'nogps', resetOrientation: false, width: src.width, height: src.height }),
    });
  } else if (o.orientation > 1 && o.orientation <= 8) {
    segments.push({ marker: 0xe1, payload: orientationExif(o.orientation) });
  }
  for (const icc of meta.icc) segments.push({ marker: 0xe2, payload: icc });
  if (segments.length) bytes = insertSegments(bytes, segments);

  let keptOriginal = false;
  if (s.neverLarger && !o.resized && bytes.byteLength >= req.file.size) {
    bytes = rewriteJpegMetadata(o.data, s.metadata);
    keptOriginal = true;
  }

  const result: CompressResult = {
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    mime: MIME.jpeg,
    extension: /\.jpe?g$/i.test(req.file.name) ? req.file.name.split('.').pop()!.toLowerCase() : EXT.jpeg,
    width: o.dims.width,
    height: o.dims.height,
    sourceWidth: o.upright.width,
    sourceHeight: o.upright.height,
    quality: keptOriginal ? s.quality : out.quality,
    ssim: keptOriginal ? 1 : out.ssim,
    keptOriginal,
    ms: Math.round(performance.now() - o.t0),
  };
  if (out.thumb) result.thumb = await jpegPreview(orientImage(out.thumb, o.orientation), 192, 0.8);
  return result;
}

/** Emscripten codecs abort when they run out of memory; say so in plain words. */
function friendlyError(message: string): { error: string; fatal: boolean } {
  if (/Aborted\(|out of memory|memory access out of bounds|Array buffer allocation failed|Invalid typed array length/i.test(message)) {
    return {
      error: 'Not enough memory to compress this picture. Try resizing it, or close other apps and try again.',
      // A codec that aborted can't be used again: the pool replaces this worker.
      fatal: true,
    };
  }
  return { error: message, fatal: false };
}

self.onmessage = async (e: MessageEvent<JobRequest>) => {
  const req = e.data;
  try {
    const result = await run(req);
    const transfer: Transferable[] = [result.bytes];
    if (result.thumb) transfer.push(result.thumb);
    if (result.originalPreview) transfer.push(result.originalPreview);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ jobId: req.jobId, ok: true, result } satisfies JobResponse, transfer);
  } catch (err) {
    const { error, fatal } = friendlyError(err instanceof Error ? err.message : String(err));
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ jobId: req.jobId, ok: false, error, fatal } satisfies JobResponse);
  }
};
