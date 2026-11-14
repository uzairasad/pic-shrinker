/**
 * Large JPEGs (scanned maps, panoramas, aerial photos: hundreds of megapixels, 50 MB and up).
 * Held whole as RGBA they need gigabytes, and the WebAssembly codecs (4 GB address space at most,
 * often less) abort on them. So they never are held whole:
 *
 * - jpeg-stream.ts decodes them a band of rows at a time,
 * - rows.ts shrinks them on the fly when a resize is set,
 * - if the result is still large, MozJPEG encodes it in bands and jpeg-join.ts joins the bands
 *   into one JPEG (baseline, with optimal Huffman tables for the whole picture);
 *   if it's small enough, it goes through the normal pipeline like any other picture.
 */
import { JpegStreamDecoder, readJpegInfo, type JpegInfo } from '../lib/jpeg-stream.ts';
import { joinJpegStrips, type StripStats } from '../lib/jpeg-join.ts';
import { AreaResizer, readAll, type LineSource } from '../lib/rows.ts';
import { ssimParts } from '../lib/ssim.ts';
import type { Settings } from '../lib/types.ts';
import { decodeEncoded } from './decode.ts';
import type { BandRequest, BandResponse } from './band.worker.ts';
import { bisectForSize, encode, lookQuality, RANGE } from './encode.ts';

/**
 * Above this many pixels a picture takes the large-picture path. A normal job holds several
 * full-size copies (decoded, codec input, decoded result for SSIM…), and the codecs fail somewhere
 * past 200 MP even on a desktop; phones run out much sooner.
 */
export const LARGE_PIXELS = 64_000_000;

/** Pixels per band handed to MozJPEG. */
const BAND_PIXELS = 8_000_000;

/** Frame size of a JPEG over LARGE_PIXELS, or null for anything else. */
export async function largeJpegInfo(file: Blob): Promise<JpegInfo | null> {
  // The frame header normally sits after EXIF/ICC (64 KB each at most); look further if needed.
  let info = readJpegInfo(new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer()));
  if (!info && file.size > 1 << 20) info = readJpegInfo(new Uint8Array(await file.arrayBuffer()));
  return info && info.width * info.height > LARGE_PIXELS ? info : null;
}

/** EXIF orientations 5–8 turn the picture a quarter turn. */
export function swapsSides(orientation: number) {
  return orientation >= 5 && orientation <= 8;
}

/** Applies an EXIF orientation to pixels (the large-picture decoder doesn't). */
export function orientImage(img: ImageData, o: number): ImageData {
  if (o < 2 || o > 8) return img;
  const { width: w, height: h } = img;
  const swap = swapsSides(o);
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const src = new Uint32Array(img.data.buffer, img.data.byteOffset, w * h);
  const outBytes = new Uint8ClampedArray(ow * oh * 4);
  const dst = new Uint32Array(outBytes.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx: number;
      let dy: number;
      switch (o) {
        case 2: dx = w - 1 - x; dy = y; break;
        case 3: dx = w - 1 - x; dy = h - 1 - y; break;
        case 4: dx = x; dy = h - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = h - 1 - y; dy = x; break;
        case 7: dx = h - 1 - y; dy = w - 1 - x; break;
        default: dx = y; dy = w - 1 - x; break;
      }
      dst[dy * ow + dx] = src[y * w + x];
    }
  }
  return new ImageData(outBytes, ow, oh);
}

/** A minimal EXIF block holding only an orientation, for pictures whose pixels weren't turned. */
export function orientationExif(o: number): Uint8Array {
  // "Exif\0\0", little-endian TIFF header, IFD0 with one SHORT entry (0x0112), no next IFD.
  return Uint8Array.from([
    0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, o, 0, 0, 0, 0, 0, 0, 0,
  ]);
}

/** Collects a small box-filtered copy of a picture as its lines go past (for the file list). */
class ThumbSink {
  readonly w: number;
  readonly h: number;
  private sum: Float64Array;
  private count: Float64Array;
  private xmap: Int32Array;
  private width: number;
  private height: number;

  constructor(width: number, height: number, maxSide: number) {
    this.width = width;
    this.height = height;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    this.w = Math.max(1, Math.round(width * scale));
    this.h = Math.max(1, Math.round(height * scale));
    this.sum = new Float64Array(this.w * this.h * 3);
    this.count = new Float64Array(this.w * this.h);
    this.xmap = new Int32Array(width);
    for (let x = 0; x < width; x++) this.xmap[x] = Math.min(this.w - 1, Math.floor((x * this.w) / width));
  }

  add(data: Uint8ClampedArray, y0: number, rows: number) {
    // Every 4th pixel each way is plenty for a thumbnail.
    for (let r = 0; r < rows; r += 1) {
      const y = y0 + r;
      if (y % 4) continue;
      const ty = Math.min(this.h - 1, Math.floor((y * this.h) / this.height));
      for (let x = 0; x < this.width; x += 4) {
        const i = (r * this.width + x) * 4;
        const t = ty * this.w + this.xmap[x];
        this.sum[t * 3] += data[i];
        this.sum[t * 3 + 1] += data[i + 1];
        this.sum[t * 3 + 2] += data[i + 2];
        this.count[t]++;
      }
    }
  }

  image(): ImageData {
    const out = new Uint8ClampedArray(this.w * this.h * 4);
    for (let t = 0; t < this.w * this.h; t++) {
      const n = this.count[t] || 1;
      out[t * 4] = this.sum[t * 3] / n;
      out[t * 4 + 1] = this.sum[t * 3 + 1] / n;
      out[t * 4 + 2] = this.sum[t * 3 + 2] / n;
      out[t * 4 + 3] = 255;
    }
    return new ImageData(out, this.w, this.h);
  }
}

export interface LargeSource {
  /** A fresh line source (the decoder reads once, so each pass opens a new one). */
  open: () => LineSource;
  width: number;
  height: number;
}

/** Opens the file's pixels as a line source, shrunk to `width`×`height` on the way if needed. */
export function largeSource(data: Uint8Array, width: number, height: number): LargeSource {
  const open = () => {
    const dec = new JpegStreamDecoder(data);
    return dec.width === width && dec.height === height ? dec : new AreaResizer(dec, width, height);
  };
  return { open, width, height };
}

/** The whole (already small enough) picture in memory. */
export function readWhole(src: LargeSource): ImageData {
  return new ImageData(readAll(src.open()), src.width, src.height);
}

function fill(src: LineSource, buf: Uint8ClampedArray, rows: number) {
  let done = 0;
  while (done < rows) {
    const n = src.readLines(buf, done, rows - done);
    if (!n) throw new Error('The picture ended early.');
    done += n;
  }
}

function bandRows(width: number, pixels = BAND_PIXELS) {
  // A multiple of 16 so every band ends on a whole JPEG block row (4:2:0 MCUs are 16 high).
  return Math.max(16, Math.floor(pixels / width / 16) * 16);
}

/** Four full-resolution tiles from across the picture, to search for a quality on. */
function proxyOf(src: LargeSource): ImageData {
  const { width: w, height: h } = src;
  const tile = Math.min(768, Math.floor(w / 2 / 16) * 16, Math.floor(h / 2 / 16) * 16);
  if (tile < 64) return readWhole(src);
  const ow = tile * 2;
  const out = new Uint8ClampedArray(ow * ow * 4);
  const xs = [0.3, 0.7].map((f) => Math.min(w - tile, Math.max(0, Math.round((f * w - tile / 2) / 16) * 16)));
  const ys = [0.3, 0.7].map((f) => Math.min(h - tile, Math.max(0, Math.round((f * h - tile / 2) / 16) * 16)));
  const lines = src.open();
  const line = new Uint8ClampedArray(w * 4);
  for (let y = 0; y <= ys[1] + tile - 1; y++) {
    fill(lines, line, 1);
    ys.forEach((ty, j) => {
      if (y < ty || y >= ty + tile) return;
      xs.forEach((tx, i) => {
        out.set(line.subarray(tx * 4, (tx + tile) * 4), ((j * tile + (y - ty)) * ow + i * tile) * 4);
      });
    });
  }
  // The same layout proxyImage() (lib/ssim.ts) makes for pictures in memory.
  return new ImageData(out, ow, ow);
}

/**
 * Helper workers (band.worker.ts) that compress bands in parallel. Nested workers exist in every
 * engine we ship on, but if one can't be started the bands are simply compressed here.
 */
class BandEncoders {
  private idle: Worker[] = [];
  private all: Worker[] = [];
  private waiting: ((w: Worker) => void)[] = [];
  private nextId = 1;

  constructor(count: number) {
    if (typeof Worker === 'undefined') return;
    for (let i = 0; i < count; i++) {
      try {
        const w = new Worker(new URL('./band.worker.ts', import.meta.url), { type: 'module' });
        this.all.push(w);
        this.idle.push(w);
      } catch {
        break;
      }
    }
  }

  get size() {
    return this.all.length;
  }

  private take(): Promise<Worker> {
    const w = this.idle.pop();
    return w ? Promise.resolve(w) : new Promise((resolve) => this.waiting.push(resolve));
  }

  private give(w: Worker) {
    const next = this.waiting.shift();
    if (next) next(w);
    else this.idle.push(w);
  }

  async run(req: Omit<BandRequest, 'id'>): Promise<Extract<BandResponse, { ok: true }>> {
    const w = await this.take();
    const id = this.nextId++;
    try {
      return await new Promise((resolve, reject) => {
        w.onmessage = (e: MessageEvent<BandResponse>) => {
          if (e.data.id !== id) return;
          if (e.data.ok) resolve(e.data);
          else reject(new Error(e.data.error));
        };
        w.onerror = (e) => reject(new Error(e.message || 'Not enough memory to compress this picture.'));
        w.postMessage({ ...req, id } satisfies BandRequest, [req.data]);
      });
    } finally {
      this.give(w);
    }
  }

  dispose() {
    for (const w of this.all) w.terminate();
    this.all = [];
    this.idle = [];
  }
}

/** Encodes the whole picture in bands at `quality` and joins them. */
async function encodeBands(
  src: LargeSource,
  s: Settings,
  quality: number,
  helpers: BandEncoders,
  opts: { score: boolean; thumb: ThumbSink | null },
) {
  const { width: w, height: h } = src;
  // Smaller bands when several are in flight, to keep memory in check.
  const rowsPer = bandRows(w, helpers.size > 1 ? BAND_PIXELS / 2 : BAND_PIXELS);
  const bandBytes = w * rowsPer * 4;
  // The similarity score is measured on up to 16 bands spread down the picture: decoding every
  // band again just to score it would add about 15% to the whole job.
  const bands = Math.ceil(h / rowsPer);
  const scoreEvery = Math.max(1, Math.floor(bands / 16));
  const scored = (k: number) => opts.score && k % scoreEvery === 0;
  const lines = src.open();
  const strips: Uint8Array[] = [];
  let sum = 0;
  let count = 0;

  if (!helpers.size) {
    const buf = new Uint8ClampedArray(bandBytes);
    for (let y = 0, k = 0; y < h; y += rowsPer, k++) {
      const n = Math.min(rowsPer, h - y);
      fill(lines, buf, n);
      const band = new ImageData(new Uint8ClampedArray(buf.buffer, 0, w * n * 4), w, n);
      opts.thumb?.add(band.data, y, n);
      const bytes = await encode('jpeg', band, s, quality, true);
      if (scored(k)) {
        const part = ssimParts(band, await decodeEncoded(bytes, 'jpeg'));
        sum += part.sum;
        count += part.count;
      }
      strips.push(new Uint8Array(bytes));
    }
    return { bytes: joinJpegStrips(strips), ssim: count ? sum / count : 1 };
  }

  // Decoding is sequential; it runs here while the helpers compress the bands already read.
  // At most one band per helper (plus the one being read) is in memory at a time.
  const free: ArrayBuffer[] = [];
  const stats: (StripStats | null)[] = [];
  const inFlight = new Set<Promise<void>>();
  let failure: unknown = null;
  for (let y = 0, k = 0; y < h; y += rowsPer, k++) {
    while (inFlight.size >= helpers.size) await Promise.race(inFlight);
    if (failure) break;
    const n = Math.min(rowsPer, h - y);
    const buffer = free.pop() ?? new ArrayBuffer(bandBytes);
    const view = new Uint8ClampedArray(buffer, 0, w * n * 4);
    fill(lines, view, n);
    opts.thumb?.add(view, y, n);
    const job = helpers
      .run({ data: buffer, width: w, height: n, settings: s, quality, score: scored(k) })
      .then((r) => {
        strips[k] = new Uint8Array(r.bytes);
        stats[k] = r.stats;
        sum += r.sum;
        count += r.count;
        free.push(r.data);
      })
      .catch((err) => {
        failure ??= err;
      })
      .finally(() => inFlight.delete(job));
    inFlight.add(job);
  }
  await Promise.all(inFlight);
  if (failure) throw failure;
  return { bytes: joinJpegStrips(strips, stats), ssim: count ? sum / count : 1 };
}

/**
 * Compresses a large picture to JPEG without ever holding it whole. Returns the joined file, the
 * quality used, its SSIM and a thumbnail.
 */
export async function compressLarge(src: LargeSource, s: Settings, wantThumb: boolean, threads: number) {
  // `threads` is how many cores this job may use (the pool shares them between running jobs).
  // Decoding can't be split, so it keeps one core and the rest compress bands.
  const helpers = new BandEncoders(threads >= 3 ? threads - 1 : threads === 2 ? 2 : 0);
  try {
    let quality = s.quality;
    const thumb = wantThumb ? new ThumbSink(src.width, src.height, 192) : null;
    if (s.mode === 'auto') {
      quality = await lookQuality('jpeg', proxyOf(src), s, s.autoTarget);
    } else if (s.mode === 'size') {
      return await sizeSearch(src, s, thumb, helpers);
    }
    const result = await encodeBands(src, s, quality, helpers, { score: true, thumb });
    return { ...result, quality, thumb: thumb?.image() ?? null };
  } finally {
    helpers.dispose();
  }
}

/**
 * Target-size mode. Every full pass costs as much as compressing the picture once, so the search
 * runs on the tile sample, and the first full pass calibrates it (the sample's bytes per pixel
 * differ from the whole picture's): usually two or three passes in all.
 */
async function sizeSearch(src: LargeSource, s: Settings, thumb: ThumbSink | null, helpers: BandEncoders) {
  const [min, max] = RANGE.jpeg;
  const target = s.targetKB * 1024;
  const proxy = proxyOf(src);
  const area = (proxy.width * proxy.height) / (src.width * src.height);
  const guess = await bisectForSize('jpeg', proxy, s, target * area, min, max);
  let quality = guess.best?.quality ?? min;
  let result = await encodeBands(src, s, quality, helpers, { score: true, thumb });

  // How much bigger (or smaller) the whole picture is than the sample predicts, at this quality.
  const predicted = (guess.best ?? guess.smallest).bytes.byteLength / area;
  const factor = result.bytes.byteLength / predicted;
  const fits = (r: { bytes: Uint8Array }) => r.bytes.byteLength <= target;
  if (Math.abs(factor - 1) > 0.05) {
    const again = (await bisectForSize('jpeg', proxy, s, (target * area) / factor, min, max)).best?.quality ?? min;
    if (again !== quality && (again > quality || !fits(result))) {
      const r = await encodeBands(src, s, again, helpers, { score: true, thumb: null });
      // Keep the better of the two that fit (or the smaller, if neither does).
      if (fits(r) ? !fits(result) || again > quality : !fits(result) && r.bytes.byteLength < result.bytes.byteLength) {
        result = r;
        quality = again;
      }
    }
  }
  for (let tries = 0; tries < 3 && !fits(result) && quality > 1; tries++) {
    quality = Math.max(1, quality - (quality > min ? 5 : 4));
    result = await encodeBands(src, s, quality, helpers, { score: true, thumb: null });
  }
  return { ...result, quality, thumb: thumb?.image() ?? null };
}
