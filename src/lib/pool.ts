import type { BandControl } from '../worker/band.worker.ts';
import type { HelperMessage, HelperReply, JobRequest, JobResponse } from '../worker/compress.worker.ts';
import type { CompressResult, Settings } from './types.ts';

interface Job {
  jobId: number;
  itemId: string;
  file: File;
  settings: Settings;
  wantThumb: boolean;
  wantPreview: boolean;
  resolve: (r: CompressResult) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  busy: Job | null;
  /** Item this worker handled last; it still has that picture decoded. */
  lastItem: string | null;
  /** Band helpers lent to this worker's current (large-picture) job. */
  helpers: Worker[];
}

const MEMORY_MESSAGE = 'Not enough memory to compress this picture. Try resizing it, or close other apps and try again.';

/**
 * Most band helpers one large picture may use. Each needs 100–150 MB while it works, so phones
 * and low-memory machines get fewer (deviceMemory is reported by Chromium-based engines only).
 */
function helperCap(): number {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  let cap = mobile ? 2 : 6;
  if (memory !== undefined) cap = Math.min(cap, memory <= 2 ? 1 : memory <= 4 ? 2 : cap);
  return cap;
}

/** Starts a band helper and resolves with it once it has loaded, or null if it can't start. */
function startHelper(): Promise<Worker | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../worker/band.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(null);
      return;
    }
    const fail = () => {
      clearTimeout(timer);
      worker.terminate();
      resolve(null);
    };
    const timer = setTimeout(fail, 15_000);
    worker.onerror = fail;
    worker.onmessage = (e: MessageEvent<BandControl>) => {
      if (e.data?.type !== 'ready') return;
      clearTimeout(timer);
      worker.onerror = null;
      worker.onmessage = null;
      resolve(worker);
    };
  });
}

/** A worker per core (capped), so a batch compresses in parallel without freezing the window. */
export class CompressPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;

  constructor(size = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  /** Starts a worker, in `existing` when replacing one (the slot object stays the one in `slots`). */
  private spawn(existing?: Slot): Slot {
    const worker = new Worker(new URL('../worker/compress.worker.ts', import.meta.url), { type: 'module' });
    const slot: Slot = existing ?? { worker, busy: null, lastItem: null, helpers: [] };
    slot.worker = worker;
    slot.busy = null;
    slot.lastItem = null;
    this.releaseHelpers(slot);
    worker.onmessage = (e: MessageEvent<JobResponse | HelperMessage>) => {
      if ('type' in e.data) {
        if (e.data.type === 'helpers') void this.lendHelpers(slot, worker, e.data.jobId, e.data.count);
        else this.releaseHelpers(slot);
        return;
      }
      this.releaseHelpers(slot);
      const job = slot.busy;
      slot.busy = null;
      if (job && job.jobId === e.data.jobId) {
        if (e.data.ok) job.resolve(e.data.result);
        else job.reject(new Error(e.data.error));
      }
      if (!e.data.ok && e.data.fatal) {
        // A codec aborted (out of memory) and can't be used again: start this slot afresh.
        worker.terminate();
        this.spawn(slot);
      }
      this.pump();
    };
    worker.onerror = (e) => {
      // A codec crashed (usually out of memory on a huge picture): replace the worker.
      this.failSlot(slot, e.message || MEMORY_MESSAGE);
    };
    return slot;
  }

  /**
   * Starts band helpers for a large picture and connects those that loaded to the job with
   * MessagePorts. A helper that crashes once working (out of memory) fails the whole job, like a
   * crash of the job's own worker: its band is gone with it.
   */
  private async lendHelpers(slot: Slot, worker: Worker, jobId: number, count: number) {
    const started = await Promise.all(Array.from({ length: Math.min(count, helperCap()) }, startHelper));
    const helpers = started.filter((h): h is Worker => h !== null);
    if (slot.worker !== worker || slot.busy?.jobId !== jobId) {
      // The job ended (or was replaced) while they were starting.
      for (const h of helpers) h.terminate();
      return;
    }
    slot.helpers = helpers;
    const ports = helpers.map((h) => {
      const channel = new MessageChannel();
      h.postMessage({ type: 'port', port: channel.port2 } satisfies BandControl, [channel.port2]);
      h.onerror = (e) => {
        e.preventDefault();
        if (slot.worker === worker && slot.helpers.includes(h)) this.failSlot(slot, MEMORY_MESSAGE);
      };
      return channel.port1;
    });
    worker.postMessage({ type: 'helper-ports', jobId, ports } satisfies HelperReply, ports);
  }

  private releaseHelpers(slot: Slot) {
    for (const h of slot.helpers ?? []) h.terminate();
    slot.helpers = [];
  }

  /** Ends a slot's job with `message` and starts its worker afresh. */
  private failSlot(slot: Slot, message: string) {
    const job = slot.busy;
    slot.busy = null;
    slot.worker.terminate();
    this.spawn(slot);
    job?.reject(new Error(message));
    this.pump();
  }

  get size() {
    return this.slots.length;
  }

  run(
    itemId: string,
    file: File,
    settings: Settings,
    opts: { wantThumb: boolean; wantPreview: boolean; priority?: boolean },
  ): Promise<CompressResult> {
    return new Promise((resolve, reject) => {
      const job: Job = { jobId: this.nextId++, itemId, file, settings, ...opts, resolve, reject };
      if (opts.priority) this.queue.unshift(job);
      else this.queue.push(job);
      this.pump();
    });
  }

  /** Drops queued (not yet started) jobs; their promises reject with "cancelled". Returns their item ids. */
  clearQueue(): string[] {
    const dropped = this.queue;
    this.queue = [];
    for (const j of dropped) j.reject(new Error('cancelled'));
    return dropped.map((j) => j.itemId);
  }

  private pump() {
    while (this.queue.length) {
      const idle = this.slots.filter((s) => !s.busy);
      if (!idle.length) return;
      const job = this.queue.shift()!;
      const slot = idle.find((s) => s.lastItem === job.itemId) ?? idle.find((s) => !s.lastItem) ?? idle[0];
      slot.busy = job;
      slot.lastItem = job.itemId;
      // Cores for a large picture's bands: shared between the jobs running now and those about to.
      const cores = navigator.hardwareConcurrency || 4;
      const jobs = Math.min(this.slots.length, this.slots.filter((s) => s.busy).length + this.queue.length);
      const req: JobRequest = {
        jobId: job.jobId,
        itemId: job.itemId,
        file: job.file,
        settings: job.settings,
        wantThumb: job.wantThumb,
        wantPreview: job.wantPreview,
        threads: Math.max(1, Math.floor(cores / Math.max(1, jobs))),
      };
      slot.worker.postMessage(req);
    }
  }

  dispose() {
    this.clearQueue();
    for (const s of this.slots) {
      s.worker.terminate();
      this.releaseHelpers(s);
    }
    this.slots = [];
  }
}
