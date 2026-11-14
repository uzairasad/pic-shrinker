/// <reference lib="webworker" />
/**
 * The compression engine. One instance per CPU core (see src/lib/pool.ts). For each job it
 * decodes the original, resizes it, encodes it with the chosen codec (searching for a quality
 * in target-size and auto modes), restores metadata, and measures SSIM against the original.
 */
import { targetDimensions } from '../lib/format.ts';
import { cleanExif, insertSegments, readJpegMetadata, rewriteJpegMetadata, type JpegSegment } from '../lib/metadata.ts';
import { proxyImage, ssim } from '../lib/ssim.ts';
import type { CompressResult, EncodableFormat, Settings } from '../lib/types.ts';
import { decodeEncoded, decodeFile, NEEDS_PREVIEW, type Decoded, type SourceKind } from './decode.ts';

export interface JobRequest {
  jobId: number;
  itemId: string;
  file: File;
  settings: Settings;
  wantThumb: boolean;
  wantPreview: boolean;
}

export type JobResponse =
  | { jobId: number; ok: true; result: CompressResult }
  | { jobId: number; ok: false; error: string };

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

function isLossless(fmt: EncodableFormat, s: Settings) {
  return fmt === 'png' || (fmt === 'webp' && s.webp.lossless) || (fmt === 'avif' && s.avif.lossless);
}

async function encode(fmt: EncodableFormat, img: ImageData, s: Settings, quality: number): Promise<ArrayBuffer> {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  switch (fmt) {
    case 'jpeg': {
      const { default: enc } = await import('@jsquash/jpeg/encode.js');
      const j = s.jpeg;
      return enc(img, {
        quality: q,
        progressive: j.progressive,
        baseline: !j.progressive,
        optimize_coding: true,
        smoothing: j.smoothing,
        // MozJpegColorSpace: 1 = grayscale, 3 = YCbCr.
        color_space: j.grayscale ? 1 : 3,
        quant_table: j.quantTable,
        trellis_multipass: j.trellis,
        trellis_opt_zero: j.trellis,
        trellis_opt_table: j.trellis,
        trellis_loops: j.trellis ? 2 : 1,
        auto_subsample: j.autoSubsample,
        chroma_subsample: j.chromaSubsample,
        separate_chroma_quality: j.separateChromaQuality,
        chroma_quality: j.separateChromaQuality ? j.chromaQuality : q,
      });
    }
    case 'webp': {
      const { default: enc } = await import('@jsquash/webp/encode.js');
      const w = s.webp;
      return enc(img, {
        quality: q,
        method: w.effort,
        lossless: w.lossless ? 1 : 0,
        near_lossless: w.lossless ? w.nearLossless : 100,
        use_sharp_yuv: w.sharpYuv ? 1 : 0,
        alpha_quality: 100,
        exact: 0,
      });
    }
    case 'avif': {
      const { default: enc } = await import('@jsquash/avif/encode.js');
      const a = s.avif;
      return enc(img, {
        quality: q,
        speed: a.speed,
        subsample: a.lossless ? 3 : a.subsample,
        lossless: a.lossless,
        enableSharpYUV: !a.lossless,
      });
    }
    case 'png': {
      const { default: optimise } = await import('@jsquash/oxipng/optimise.js');
      return optimise(img, { level: s.png.level, interlace: s.png.interlace, optimiseAlpha: true });
    }
  }
}

/** Quality search range per codec (outside it, results are either awful or wasteful). */
const RANGE: Record<EncodableFormat, [number, number]> = {
  jpeg: [10, 96],
  webp: [10, 96],
  avif: [10, 92],
  png: [100, 100],
};

/** Highest quality whose file fits in `targetBytes`, by binary search on `img`. */
async function bisectForSize(fmt: EncodableFormat, img: ImageData, s: Settings, targetBytes: number, lo: number, hi: number) {
  let best: { bytes: ArrayBuffer; quality: number } | null = null;
  let smallest: { bytes: ArrayBuffer; quality: number } | null = null;
  while (lo <= hi) {
    const q = Math.floor((lo + hi) / 2);
    const bytes = await encode(fmt, img, s, q);
    if (!smallest || bytes.byteLength < smallest.bytes.byteLength) smallest = { bytes, quality: q };
    if (bytes.byteLength <= targetBytes) {
      best = { bytes, quality: q };
      lo = q + 1;
    } else {
      hi = q - 1;
    }
  }
  return { best, smallest: smallest! };
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
  let [lo, hi] = RANGE[fmt];
  let found = hi;
  while (lo <= hi) {
    const q = Math.floor((lo + hi) / 2);
    const bytes = await encode(fmt, proxy, s, q);
    const score = ssim(proxy, await decodeEncoded(bytes, fmt));
    if (score >= target) {
      found = q;
      hi = q - 1;
    } else {
      lo = q + 1;
    }
  }
  return { quality: found, bytes: await encode(fmt, img, s, found) };
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

  const { image: source, kind } = await decodeCached(req.itemId, req.file, carryMeta);
  const fmt = resolveFormat(s, kind);
  const dims = targetDimensions(source.width, source.height, s.resize);
  const resized = dims.width !== source.width || dims.height !== source.height;

  let img = source;
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

  if (fmt === 'jpeg' && carryMeta) {
    const meta = readJpegMetadata(new Uint8Array(await req.file.arrayBuffer()));
    const segments: JpegSegment[] = [];
    if (meta.exif && (s.metadata === 'keep' || s.metadata === 'nogps')) {
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
    sourceWidth: source.width,
    sourceHeight: source.height,
    quality,
    ssim: score,
    keptOriginal,
    ms: Math.round(performance.now() - t0),
  };
  if (req.wantThumb) result.thumb = await jpegPreview(source, 192, 0.8);
  if (req.wantPreview && NEEDS_PREVIEW.includes(kind)) result.originalPreview = await jpegPreview(source, 4096, 0.92);
  return result;
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
    const error = err instanceof Error ? err.message : String(err);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ jobId: req.jobId, ok: false, error } satisfies JobResponse);
  }
};
