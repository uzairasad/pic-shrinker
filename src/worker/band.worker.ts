/// <reference lib="webworker" />
/**
 * Helper for large pictures (large.ts): compresses one band with MozJPEG, and optionally scores
 * it (SSIM against the band's pixels). A large job starts several of these so the bands of one
 * picture compress on every core instead of one.
 */
import { stripStats, type StripStats } from '../lib/jpeg-join.ts';
import { ssimParts } from '../lib/ssim.ts';
import type { Settings } from '../lib/types.ts';
import { decodeEncoded } from './decode.ts';
import { encode } from './encode.ts';

export interface BandRequest {
  id: number;
  /** RGBA pixels; the buffer is transferred here and back, so the caller can reuse it. */
  data: ArrayBuffer;
  width: number;
  height: number;
  settings: Settings;
  quality: number;
  score: boolean;
}

export type BandResponse =
  | { id: number; ok: true; bytes: ArrayBuffer; data: ArrayBuffer; sum: number; count: number; stats: StripStats | null }
  | { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<BandRequest>) => {
  const { id, data, width, height, settings, quality, score } = e.data;
  try {
    const band = new ImageData(new Uint8ClampedArray(data, 0, width * height * 4), width, height);
    const bytes = await encode('jpeg', band, settings, quality, true);
    let sum = 0;
    let count = 0;
    if (score) ({ sum, count } = ssimParts(band, await decodeEncoded(bytes, 'jpeg')));
    // Huffman symbol counts for the join, done here so they run in parallel too.
    const stats = stripStats(new Uint8Array(bytes));
    scope.postMessage({ id, ok: true, bytes, data, sum, count, stats } satisfies BandResponse, [bytes, data]);
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies BandResponse);
  }
};
