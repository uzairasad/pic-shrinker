/**
 * Structural similarity (SSIM) between two RGBA images of the same size, on luma, averaged over
 * non-overlapping 8×8 windows. 1 means identical; above about 0.98 most people can't tell the
 * difference at 100% zoom.
 */

interface Pixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

function luma(img: Pixels): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // Composite onto white so transparent areas compare by what's visible.
    const a = d[j + 3] / 255;
    const r = d[j] * a + 255 * (1 - a);
    const g = d[j + 1] * a + 255 * (1 - a);
    const b = d[j + 2] * a + 255 * (1 - a);
    out[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return out;
}

export function ssim(a: Pixels, b: Pixels, window = 8): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('ssim: size mismatch');
  const { width: w, height: h } = a;
  const la = luma(a);
  const lb = luma(b);
  if (w < window || h < window) {
    return windowSsim(la, lb, w, 0, 0, w, h);
  }
  let sum = 0;
  let count = 0;
  for (let y = 0; y + window <= h; y += window) {
    for (let x = 0; x + window <= w; x += window) {
      sum += windowSsim(la, lb, w, x, y, window, window);
      count++;
    }
  }
  return count ? sum / count : 1;
}

function windowSsim(
  la: Float32Array,
  lb: Float32Array,
  stride: number,
  x0: number,
  y0: number,
  ww: number,
  wh: number,
): number {
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let y = y0; y < y0 + wh; y++) {
    let i = y * stride + x0;
    for (let x = 0; x < ww; x++, i++) {
      const va = la[i];
      const vb = lb[i];
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
  }
  const n = ww * wh;
  const ma = sa / n;
  const mb = sb / n;
  const va = saa / n - ma * ma;
  const vb = sbb / n - mb * mb;
  const cov = sab / n - ma * mb;
  return ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
}

/**
 * A smaller stand-in for a large picture, used while searching for a quality: four tiles from
 * across the image, at full resolution (so compression artefacts look the same as in the real
 * file). Tiles are multiples of 16 px so JPEG blocks line up.
 */
export function proxyImage<T extends Pixels>(
  img: T,
  make: (data: Uint8ClampedArray, w: number, h: number) => T,
  maxPixels = 3_000_000,
  tile = 768,
): T {
  const { width: w, height: h } = img;
  if (w * h <= maxPixels || w < tile * 2 || h < tile * 2) return img;
  const out = new Uint8ClampedArray(tile * 2 * tile * 2 * 4);
  const ow = tile * 2;
  const origins = [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.3, 0.7],
    [0.7, 0.7],
  ];
  origins.forEach(([fx, fy], k) => {
    const sx = Math.min(w - tile, Math.max(0, Math.round((fx * w - tile / 2) / 16) * 16));
    const sy = Math.min(h - tile, Math.max(0, Math.round((fy * h - tile / 2) / 16) * 16));
    const dx = (k % 2) * tile;
    const dy = Math.floor(k / 2) * tile;
    for (let y = 0; y < tile; y++) {
      const src = ((sy + y) * w + sx) * 4;
      out.set(img.data.subarray(src, src + tile * 4), ((dy + y) * ow + dx) * 4);
    }
  });
  return make(out, ow, ow);
}
