/**
 * Row-streaming helpers for pictures too large to hold whole: a common "line source" shape and
 * an area-averaging resizer that reads its source top to bottom, a few lines at a time.
 */

/** Something that hands out RGBA lines in order, top to bottom. */
export interface LineSource {
  readonly width: number;
  readonly height: number;
  /** Writes up to `count` lines into `out` from line `outRow`; returns how many it wrote. */
  readLines(out: Uint8ClampedArray, outRow: number, count: number): number;
}

const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const LUT_SIZE = 4096;
const TO_SRGB = new Uint8Array(LUT_SIZE + 1);
for (let i = 0; i <= LUT_SIZE; i++) {
  const l = i / LUT_SIZE;
  TO_SRGB[i] = Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055));
}

/** For each output position: the source range it covers, with edge weights. */
function axis(outSize: number, inSize: number) {
  const scale = inSize / outSize;
  const from = new Int32Array(outSize);
  const to = new Int32Array(outSize);
  const wFirst = new Float32Array(outSize);
  const wLast = new Float32Array(outSize);
  for (let o = 0; o < outSize; o++) {
    // Enlarging: sample the nearest source pixel.
    const a = scale >= 1 ? o * scale : Math.min(inSize - 1, Math.floor((o + 0.5) * scale));
    const b = scale >= 1 ? (o + 1) * scale : a + 1;
    const f = Math.floor(a);
    const l = Math.min(inSize - 1, Math.ceil(b) - 1);
    from[o] = f;
    to[o] = l;
    wFirst[o] = f === l ? b - a : f + 1 - a;
    wLast[o] = f === l ? 0 : b - l;
  }
  return { from, to, wFirst, wLast, scale: Math.max(scale, 1) };
}

/**
 * Downscales by averaging every source pixel an output pixel covers (in linear light, so thin
 * lines and text keep their weight), which is what you want for big reductions. Enlarging falls
 * back to nearest neighbour. Sources are opaque (JPEG), so alpha is ignored and comes out 255.
 */
export class AreaResizer implements LineSource {
  readonly width: number;
  readonly height: number;
  private src: LineSource;
  private ax: ReturnType<typeof axis>;
  private ay: ReturnType<typeof axis>;
  private srcLine: Uint8ClampedArray;
  /** Source line `cachedY`, resampled horizontally, in linear light (RGB). */
  private cached: Float32Array;
  private cachedY = -1;
  private acc: Float32Array;
  private line = 0;

  constructor(src: LineSource, width: number, height: number) {
    this.src = src;
    this.width = width;
    this.height = height;
    this.ax = axis(width, src.width);
    this.ay = axis(height, src.height);
    this.srcLine = new Uint8ClampedArray(src.width * 4);
    this.cached = new Float32Array(width * 3);
    this.acc = new Float32Array(width * 3);
  }

  /** Horizontally resampled source line `y` (lines are read strictly in order). */
  private sourceLine(y: number): Float32Array {
    while (this.cachedY < y) {
      if (this.src.readLines(this.srcLine, 0, 1) !== 1) throw new Error('The picture ended early.');
      this.cachedY++;
    }
    if (this.resampledY === y) return this.cached;
    this.resampledY = y;
    const s = this.srcLine;
    const out = this.cached;
    const { from, to, wFirst, wLast } = this.ax;
    for (let x = 0; x < this.width; x++) {
      const f = from[x];
      const l = to[x];
      let i = f * 4;
      let w = wFirst[x];
      let r = TO_LINEAR[s[i]] * w;
      let g = TO_LINEAR[s[i + 1]] * w;
      let b = TO_LINEAR[s[i + 2]] * w;
      for (let sx = f + 1; sx < l; sx++) {
        i += 4;
        r += TO_LINEAR[s[i]];
        g += TO_LINEAR[s[i + 1]];
        b += TO_LINEAR[s[i + 2]];
      }
      if (l > f) {
        i = l * 4;
        w = wLast[x];
        r += TO_LINEAR[s[i]] * w;
        g += TO_LINEAR[s[i + 1]] * w;
        b += TO_LINEAR[s[i + 2]] * w;
      }
      const o = x * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
    return out;
  }

  private resampledY = -1;

  readLines(out: Uint8ClampedArray, outRow: number, count: number): number {
    const n = Math.min(count, this.height - this.line);
    const W = this.width;
    const { from, to, wFirst, wLast, scale } = this.ay;
    const norm = LUT_SIZE / (scale * this.ax.scale);
    const acc = this.acc;
    for (let k = 0; k < n; k++) {
      const y = this.line + k;
      acc.fill(0);
      for (let sy = from[y]; sy <= to[y]; sy++) {
        const w = sy === from[y] ? wFirst[y] : sy === to[y] ? wLast[y] : 1;
        if (w <= 0) continue;
        const line = this.sourceLine(sy);
        for (let i = 0; i < acc.length; i++) acc[i] += line[i] * w;
      }
      let o = (outRow + k) * W * 4;
      for (let i = 0; i < acc.length; i += 3, o += 4) {
        out[o] = TO_SRGB[Math.min(LUT_SIZE, (acc[i] * norm + 0.5) | 0)];
        out[o + 1] = TO_SRGB[Math.min(LUT_SIZE, (acc[i + 1] * norm + 0.5) | 0)];
        out[o + 2] = TO_SRGB[Math.min(LUT_SIZE, (acc[i + 2] * norm + 0.5) | 0)];
        out[o + 3] = 255;
      }
    }
    this.line += n;
    return n;
  }
}

/** Reads a whole line source into one RGBA buffer (only for pictures that fit in memory). */
export function readAll(src: LineSource): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(src.width * src.height * 4);
  let y = 0;
  while (y < src.height) {
    const n = src.readLines(out, y, Math.min(256, src.height - y));
    if (!n) throw new Error('The picture ended early.');
    y += n;
  }
  return out;
}
