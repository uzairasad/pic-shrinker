/** The codecs, and the quality searches that only need a (small) picture in memory. */
import { ssim } from '../lib/ssim.ts';
import type { EncodableFormat, Settings } from '../lib/types.ts';
import { decodeEncoded } from './decode.ts';

export function isLossless(fmt: EncodableFormat, s: Settings) {
  return fmt === 'png' || (fmt === 'webp' && s.webp.lossless) || (fmt === 'avif' && s.avif.lossless);
}

/**
 * `strip`: a band of a larger JPEG that jpeg-join.ts will stitch together, so baseline. Its
 * Huffman tables are still optimised: with `optimize_coding` off, MozJPEG doesn't fall back to the
 * standard tables but writes cut-down ones that can lack codes the band needs (a 500 MP panorama
 * came out striped with noise). The joiner builds new tables for the whole picture anyway.
 */
export async function encode(fmt: EncodableFormat, img: ImageData, s: Settings, quality: number, strip = false): Promise<ArrayBuffer> {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  switch (fmt) {
    case 'jpeg': {
      const { default: enc } = await import('@jsquash/jpeg/encode.js');
      const j = s.jpeg;
      return enc(img, {
        quality: q,
        progressive: j.progressive && !strip,
        baseline: !j.progressive || strip,
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
export const RANGE: Record<EncodableFormat, [number, number]> = {
  jpeg: [10, 96],
  webp: [10, 96],
  avif: [10, 92],
  png: [100, 100],
};

/** Highest quality whose file fits in `targetBytes`, by binary search on `img`. */
export async function bisectForSize(fmt: EncodableFormat, img: ImageData, s: Settings, targetBytes: number, lo: number, hi: number) {
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

/** Lowest quality whose SSIM on `proxy` reaches `target`. */
export async function lookQuality(fmt: EncodableFormat, proxy: ImageData, s: Settings, target: number): Promise<number> {
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
  return found;
}
