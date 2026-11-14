/// <reference lib="webworker" />
/**
 * Helper for large pictures (large.ts): compresses one band with MozJPEG, optionally scores it
 * (SSIM against the band's pixels) and counts its Huffman symbols for the join. A large job uses
 * several so the bands of one picture compress on every core instead of one.
 *
 * Helpers are started by the page (pool.ts), not by the job's worker: the system web engines
 * the apps run in (WKWebView, Android WebView) don't reliably start a worker from inside a
 * worker. The page then connects each one that loaded to the job with a MessagePort.
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
  | { id: number; ok: false; error: string; data?: ArrayBuffer };

/** To the page: `ready` once this script has loaded. From the page: the port to the job. */
export type BandControl = { type: 'ready' } | { type: 'port'; port: MessagePort };

const scope = self as unknown as DedicatedWorkerGlobalScope;

async function serve(req: BandRequest, port: MessagePort) {
  const { id, data, width, height, settings, quality, score } = req;
  try {
    const band = new ImageData(new Uint8ClampedArray(data, 0, width * height * 4), width, height);
    const bytes = await encode('jpeg', band, settings, quality, true);
    let sum = 0;
    let count = 0;
    if (score) ({ sum, count } = ssimParts(band, await decodeEncoded(bytes, 'jpeg')));
    // Huffman symbol counts for the join, done here so they run in parallel too.
    const stats = stripStats(new Uint8Array(bytes));
    port.postMessage({ id, ok: true, bytes, data, sum, count, stats } satisfies BandResponse, [bytes, data]);
  } catch (err) {
    // Hand the pixels back, so the job can compress this band itself.
    const back = data.byteLength ? [data] : [];
    port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err), data: back.length ? data : undefined } satisfies BandResponse, back);
  }
}

scope.onmessage = (e: MessageEvent<BandControl>) => {
  if (e.data?.type !== 'port') return;
  const port = e.data.port;
  port.onmessage = (m: MessageEvent<BandRequest>) => void serve(m.data, port);
};

// Loaded (imports included): the page may connect this helper to a job.
scope.postMessage({ type: 'ready' } satisfies BandControl);
