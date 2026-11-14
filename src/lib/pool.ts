import type { JobRequest, JobResponse } from '../worker/compress.worker.ts';
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
}

/** A worker per core (capped), so a batch compresses in parallel without freezing the window. */
export class CompressPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;

  constructor(size = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  private spawn(): Slot {
    const worker = new Worker(new URL('../worker/compress.worker.ts', import.meta.url), { type: 'module' });
    const slot: Slot = { worker, busy: null, lastItem: null };
    worker.onmessage = (e: MessageEvent<JobResponse>) => {
      const job = slot.busy;
      slot.busy = null;
      if (job && job.jobId === e.data.jobId) {
        if (e.data.ok) job.resolve(e.data.result);
        else job.reject(new Error(e.data.error));
      }
      this.pump();
    };
    worker.onerror = (e) => {
      // A codec crashed (usually out of memory on a huge picture): replace the worker.
      const job = slot.busy;
      slot.busy = null;
      worker.terminate();
      const fresh = this.spawn();
      Object.assign(slot, fresh);
      job?.reject(new Error(e.message || 'The compressor ran out of memory on this picture.'));
      this.pump();
    };
    return slot;
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
      const req: JobRequest = {
        jobId: job.jobId,
        itemId: job.itemId,
        file: job.file,
        settings: job.settings,
        wantThumb: job.wantThumb,
        wantPreview: job.wantPreview,
      };
      slot.worker.postMessage(req);
    }
  }

  dispose() {
    this.clearQueue();
    for (const s of this.slots) s.worker.terminate();
    this.slots = [];
  }
}
