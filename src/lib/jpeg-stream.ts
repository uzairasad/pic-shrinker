/**
 * A JPEG decoder that hands out pixel rows a strip at a time, for pictures too big to hold as one
 * RGBA image (large scanned maps run to hundreds of megapixels; the browser decoders and the
 * WebAssembly codecs run out of memory on them).
 *
 * Baseline files are decoded as they stream: only a few MCU rows of samples are kept. Progressive
 * files need every coefficient before any pixel is final, so those are kept per MCU row as
 * Int16Arrays (about 2–3 bytes per pixel instead of 4, and never one giant allocation).
 *
 * Supports 8-bit Huffman-coded baseline, extended and progressive JPEGs with 1, 3 or 4 components,
 * any sampling factors and restart intervals. Upsampling is bilinear (what libjpeg calls "fancy").
 * Colour profiles are not applied: pixel values come out as stored.
 */
import { BitReader, buildHuffman, JpegError, ZIGZAG, type HuffmanTable } from './jpeg-huffman.ts';

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  /** Blocks per line / column that hold picture data. */
  bpl: number;
  bpc: number;
  /** Block columns per line, padded to whole MCUs. */
  bplPadded: number;
  /** Coefficients, one Int16Array per MCU row (v block rows × bplPadded blocks × 64). */
  rows: Int16Array[];
  pred: number;
  dcTable?: HuffmanTable;
  acTable?: HuffmanTable;
  /** Decoded samples of the MCU rows around the current one (ring of 3). */
  planes: Uint8ClampedArray[];
  /** Plane width in samples (bplPadded × 8). */
  stride: number;
  /** Real width / height in samples. */
  cw: number;
  ch: number;
}

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
  progressive: boolean;
}

interface Scan {
  comps: Component[];
  ss: number;
  se: number;
  ah: number;
  al: number;
  start: number;
}

function u16(d: Uint8Array, i: number) {
  return (d[i] << 8) | d[i + 1];
}

/** Reads just the size from the frame header, without decoding anything. */
export function readJpegInfo(d: Uint8Array): JpegInfo | null {
  if (d[0] !== 0xff || d[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= d.length) {
    if (d[i] !== 0xff) {
      i++;
      continue;
    }
    const m = d[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    if (m === 0xd9 || m === 0xda) return null;
    const len = u16(d, i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: u16(d, i + 5), width: u16(d, i + 7), components: d[i + 9], progressive: m === 0xc2 || m === 0xc6 || m === 0xca || m === 0xce };
    }
    i += 2 + len;
  }
  return null;
}

/** 8×8 inverse DCT of dequantised coefficients into `out` (stb_image's integer IDCT). */
function idct(c: Int16Array, off: number, q: Uint16Array, out: Uint8ClampedArray, outOff: number, stride: number, tmp: Int32Array) {
  for (let i = 0; i < 8; i++) {
    const o = off + i;
    const s1 = c[o + 8] * q[i + 8];
    const s2 = c[o + 16] * q[i + 16];
    const s3 = c[o + 24] * q[i + 24];
    const s4 = c[o + 32] * q[i + 32];
    const s5 = c[o + 40] * q[i + 40];
    const s6 = c[o + 48] * q[i + 48];
    const s7 = c[o + 56] * q[i + 56];
    const s0 = c[o] * q[i];
    if ((s1 | s2 | s3 | s4 | s5 | s6 | s7) === 0) {
      const dc = s0 * 4;
      tmp[i] = tmp[i + 8] = tmp[i + 16] = tmp[i + 24] = tmp[i + 32] = tmp[i + 40] = tmp[i + 48] = tmp[i + 56] = dc;
      continue;
    }
    let p1 = (s2 + s6) * 2217;
    const t2a = p1 + s6 * -7567;
    const t3a = p1 + s2 * 3135;
    const t0a = (s0 + s4) * 4096;
    const t1a = (s0 - s4) * 4096;
    const x0 = t0a + t3a + 512;
    const x3 = t0a - t3a + 512;
    const x1 = t1a + t2a + 512;
    const x2 = t1a - t2a + 512;
    let t0 = s7;
    let t1 = s5;
    let t2 = s3;
    let t3 = s1;
    let p3 = t0 + t2;
    let p4 = t1 + t3;
    p1 = t0 + t3;
    let p2 = t1 + t2;
    const p5 = (p3 + p4) * 4816;
    t0 *= 1223;
    t1 *= 8410;
    t2 *= 12586;
    t3 *= 6149;
    p1 = p5 + p1 * -3685;
    p2 = p5 + p2 * -10497;
    p3 *= -8034;
    p4 *= -1597;
    t3 += p1 + p4;
    t2 += p2 + p3;
    t1 += p2 + p4;
    t0 += p1 + p3;
    tmp[i] = (x0 + t3) >> 10;
    tmp[i + 56] = (x0 - t3) >> 10;
    tmp[i + 8] = (x1 + t2) >> 10;
    tmp[i + 48] = (x1 - t2) >> 10;
    tmp[i + 16] = (x2 + t1) >> 10;
    tmp[i + 40] = (x2 - t1) >> 10;
    tmp[i + 24] = (x3 + t0) >> 10;
    tmp[i + 32] = (x3 - t0) >> 10;
  }
  for (let i = 0; i < 8; i++) {
    const v = i * 8;
    const s0 = tmp[v];
    const s1 = tmp[v + 1];
    const s2 = tmp[v + 2];
    const s3 = tmp[v + 3];
    const s4 = tmp[v + 4];
    const s5 = tmp[v + 5];
    const s6 = tmp[v + 6];
    const s7 = tmp[v + 7];
    let p1 = (s2 + s6) * 2217;
    const t2a = p1 + s6 * -7567;
    const t3a = p1 + s2 * 3135;
    const t0a = (s0 + s4) * 4096;
    const t1a = (s0 - s4) * 4096;
    const bias = 65536 + (128 << 17);
    const x0 = t0a + t3a + bias;
    const x3 = t0a - t3a + bias;
    const x1 = t1a + t2a + bias;
    const x2 = t1a - t2a + bias;
    let t0 = s7;
    let t1 = s5;
    let t2 = s3;
    let t3 = s1;
    let p3 = t0 + t2;
    let p4 = t1 + t3;
    p1 = t0 + t3;
    let p2 = t1 + t2;
    const p5 = (p3 + p4) * 4816;
    t0 *= 1223;
    t1 *= 8410;
    t2 *= 12586;
    t3 *= 6149;
    p1 = p5 + p1 * -3685;
    p2 = p5 + p2 * -10497;
    p3 *= -8034;
    p4 *= -1597;
    t3 += p1 + p4;
    t2 += p2 + p3;
    t1 += p2 + p4;
    t0 += p1 + p3;
    const o = outOff + i * stride;
    out[o] = (x0 + t3) >> 17;
    out[o + 7] = (x0 - t3) >> 17;
    out[o + 1] = (x1 + t2) >> 17;
    out[o + 6] = (x1 - t2) >> 17;
    out[o + 2] = (x2 + t1) >> 17;
    out[o + 5] = (x2 - t1) >> 17;
    out[o + 3] = (x3 + t0) >> 17;
    out[o + 4] = (x3 - t0) >> 17;
  }
}

// YCbCr → RGB lookup tables (as libjpeg's jdcolor.c), and a clamp table for the sums.
const CR_R = new Int32Array(256);
const CB_B = new Int32Array(256);
const CR_G = new Int32Array(256);
const CB_G = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i - 128;
  CR_R[i] = Math.round(1.402 * v);
  CB_B[i] = Math.round(1.772 * v);
  CR_G[i] = Math.round(-0.714136 * v * 65536);
  CB_G[i] = Math.round(-0.344136 * v * 65536) + 32768;
}
const CLAMP_OFFSET = 384;
const CLAMP = new Uint8Array(1024);
for (let i = 0; i < 1024; i++) CLAMP[i] = Math.max(0, Math.min(255, i - CLAMP_OFFSET));

/**
 * Doubles a line's width with ¾ + ¼ weights (the usual 2× chroma subsampling; the same result as
 * the general bilinear path, without its index tables). `shift`/`round` undo the input's scale
 * plus the 4 of the weights.
 */
function widen2(src: ArrayLike<number>, so: number, n: number, dst: Uint8Array, W: number, shift: number, round: number) {
  const last = n - 1;
  for (let j = 0, x = 0; j < n && x < W; j++, x += 2) {
    const c3 = 3 * src[so + j];
    dst[x] = (c3 + src[so + (j > 0 ? j - 1 : 0)] + round) >> shift;
    if (x + 1 < W) dst[x + 1] = (c3 + src[so + (j < last ? j + 1 : last)] + round) >> shift;
  }
}

/** Precomputed bilinear upsampling positions along one axis. */
function upsampleAxis(outSize: number, inSize: number, factor: number, max: number) {
  const i0 = new Int32Array(outSize);
  const i1 = new Int32Array(outSize);
  const w1 = new Int32Array(outSize);
  for (let x = 0; x < outSize; x++) {
    const p = Math.max(0, ((x + 0.5) * factor) / max - 0.5);
    const a = Math.min(inSize - 1, Math.floor(p));
    i0[x] = a;
    i1[x] = Math.min(inSize - 1, a + 1);
    w1[x] = Math.round((p - a) * 256);
  }
  return { i0, i1, w1 };
}

export class JpegStreamDecoder implements JpegInfo {
  readonly width: number;
  readonly height: number;
  readonly components: number;
  readonly progressive: boolean;

  private d: Uint8Array;
  private comps: Component[] = [];
  private qt: Uint16Array[] = [];
  private dc: HuffmanTable[] = [];
  private ac: HuffmanTable[] = [];
  private restartInterval = 0;
  private hmax = 1;
  private vmax = 1;
  private mcusPerLine = 0;
  private mcusPerColumn = 0;
  private adobe: number | null = null;
  private jfif = false;
  /** Set when the whole picture comes from one interleaved baseline scan (decoded as it goes). */
  private streaming: { scan: Scan; reader: BitReader; mcu: number } | null = null;
  /** Next MCU row whose coefficients get decoded (streaming) and next one turned into samples. */
  private decodedRows = 0;
  private sampledRows = 0;
  /** Next picture line to hand out. */
  line = 0;
  private tmp = new Int32Array(64);
  private rowBuf?: Uint8Array[];
  private vline?: Int32Array[];
  private ups: ReturnType<typeof upsampleAxis>[] = [];

  constructor(data: Uint8Array) {
    this.d = data;
    let i = this.parseHeaders(2);
    if (!this.comps.length) throw new JpegError('No picture data found in this JPEG.');
    this.width = this.frameW;
    this.height = this.frameH;
    this.components = this.comps.length;
    this.progressive = this.isProgressive;
    // Decode scans until we either can stream (one baseline scan with every component), or have
    // read every scan (progressive / multi-scan).
    for (;;) {
      const scan = this.readScanHeader(i);
      if (!scan) break;
      const allIn = scan.comps.length === this.comps.length;
      if (!this.isProgressive && allIn && !this.decodedAny) {
        this.allocate(false);
        this.streaming = { scan, reader: new BitReader(this.d, scan.start), mcu: 0 };
        return;
      }
      this.allocate(true);
      i = this.decodeWholeScan(scan);
      i = this.parseHeaders(i);
    }
    this.allocate(true);
    this.decodedRows = this.mcusPerColumn;
  }

  private frameW = 0;
  private frameH = 0;
  private isProgressive = false;
  private decodedAny = false;
  private allocated = false;

  /** Reads markers from `i` up to the next SOS (returns its position) or EOI. */
  private parseHeaders(i: number): number {
    const d = this.d;
    while (i + 4 <= d.length) {
      if (d[i] !== 0xff) {
        i++;
        continue;
      }
      const m = d[i + 1];
      if (m === 0xff || m === 0x00 || (m >= 0xd0 && m <= 0xd7) || m === 0xd8 || m === 0x01) {
        i += m === 0xff ? 1 : 2;
        continue;
      }
      if (m === 0xd9 || m === 0xda) return i;
      const len = u16(d, i + 2);
      const p = i + 4;
      const end = i + 2 + len;
      if (end > d.length) throw new JpegError('This JPEG is cut short.');
      switch (m) {
        case 0xdb: {
          let k = p;
          while (k < end) {
            const pq = d[k] >> 4;
            const tq = d[k] & 15;
            k++;
            const t = new Uint16Array(64);
            for (let j = 0; j < 64; j++) {
              t[ZIGZAG[j]] = pq ? u16(d, k + j * 2) : d[k + j];
            }
            k += pq ? 128 : 64;
            this.qt[tq] = t;
          }
          break;
        }
        case 0xc4: {
          let k = p;
          while (k < end) {
            const tc = d[k] >> 4;
            const th = d[k] & 15;
            const counts = d.subarray(k + 1, k + 17);
            let n = 0;
            for (let j = 0; j < 16; j++) n += counts[j];
            const values = d.slice(k + 17, k + 17 + n);
            (tc === 0 ? this.dc : this.ac)[th] = buildHuffman(counts, values);
            k += 17 + n;
          }
          break;
        }
        case 0xdd:
          this.restartInterval = u16(d, p);
          break;
        case 0xe0:
          if (d[p] === 0x4a && d[p + 1] === 0x46 && d[p + 2] === 0x49 && d[p + 3] === 0x46) this.jfif = true;
          break;
        case 0xee:
          if (d[p] === 0x41 && d[p + 1] === 0x64 && d[p + 2] === 0x6f && d[p + 3] === 0x62 && d[p + 4] === 0x65) this.adobe = d[p + 11];
          break;
        case 0xc0:
        case 0xc1:
        case 0xc2: {
          if (d[p] !== 8) throw new JpegError('Only 8-bit JPEGs can be read in large-picture mode.');
          this.isProgressive = m === 0xc2;
          this.frameH = u16(d, p + 1);
          this.frameW = u16(d, p + 3);
          if (!this.frameW || !this.frameH) throw new JpegError('This JPEG has no size in its header.');
          const n = d[p + 5];
          if (n !== 1 && n !== 3 && n !== 4) throw new JpegError(`JPEGs with ${n} colour channels aren't supported.`);
          for (let c = 0; c < n; c++) {
            const o = p + 6 + c * 3;
            this.comps.push({
              id: d[o],
              h: n === 1 ? 1 : d[o + 1] >> 4 || 1,
              v: n === 1 ? 1 : d[o + 1] & 15 || 1,
              tq: d[o + 2],
              bpl: 0,
              bpc: 0,
              bplPadded: 0,
              rows: [],
              pred: 0,
              planes: [],
              stride: 0,
              cw: 0,
              ch: 0,
            });
          }
          break;
        }
        default:
          if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
            throw new JpegError('This kind of JPEG (lossless or arithmetic-coded) is not supported.');
          }
      }
      i = end;
    }
    return i;
  }

  private readScanHeader(i: number): Scan | null {
    const d = this.d;
    if (i + 4 > d.length || d[i] !== 0xff || d[i + 1] !== 0xda) return null;
    const len = u16(d, i + 2);
    const n = d[i + 4];
    const comps: Component[] = [];
    for (let k = 0; k < n; k++) {
      const id = d[i + 5 + k * 2];
      const tables = d[i + 6 + k * 2];
      const c = this.comps.find((x) => x.id === id);
      if (!c) throw new JpegError('Damaged JPEG: a scan names an unknown channel.');
      c.dcTable = this.dc[tables >> 4];
      c.acTable = this.ac[tables & 15];
      comps.push(c);
    }
    const o = i + 5 + n * 2;
    return { comps, ss: d[o], se: d[o + 1], ah: d[o + 2] >> 4, al: d[o + 2] & 15, start: i + 2 + len };
  }

  private allocate(keepAll: boolean) {
    if (this.allocated) return;
    this.allocated = true;
    this.hmax = Math.max(...this.comps.map((c) => c.h));
    this.vmax = Math.max(...this.comps.map((c) => c.v));
    this.mcusPerLine = Math.ceil(this.frameW / (8 * this.hmax));
    this.mcusPerColumn = Math.ceil(this.frameH / (8 * this.vmax));
    for (const c of this.comps) {
      c.cw = Math.ceil((this.frameW * c.h) / this.hmax);
      c.ch = Math.ceil((this.frameH * c.v) / this.vmax);
      c.bpl = Math.ceil(c.cw / 8);
      c.bpc = Math.ceil(c.ch / 8);
      c.bplPadded = this.mcusPerLine * c.h;
      c.stride = c.bplPadded * 8;
      const rowSize = c.bplPadded * c.v * 64;
      // Streaming keeps one MCU row of coefficients, reused.
      const count = keepAll ? this.mcusPerColumn : 1;
      for (let r = 0; r < count; r++) c.rows.push(new Int16Array(rowSize));
      for (let k = 0; k < 3; k++) c.planes.push(new Uint8ClampedArray(c.stride * c.v * 8));
      this.ups.push(upsampleAxis(this.frameW, c.cw, c.h, this.hmax));
    }
  }

  /** Coefficient storage for block (row, col) of a component. */
  private block(c: Component, row: number, col: number): [Int16Array, number] {
    const r = Math.floor(row / c.v);
    const store = c.rows.length === 1 ? c.rows[0] : c.rows[r];
    return [store, ((row - r * c.v) * c.bplPadded + col) * 64];
  }

  private decodeBlock(scan: Scan, reader: BitReader, c: Component, blk: Int16Array, off: number, eob: { run: number }) {
    const { ss, se, ah, al } = scan;
    if (!this.isProgressive) {
      const t = reader.decode(c.dcTable!);
      c.pred += reader.receiveExtend(t);
      blk[off] = c.pred;
      const ac = c.acTable!;
      for (let k = 1; k < 64; ) {
        const rs = reader.decode(ac);
        const s = rs & 15;
        const r = rs >> 4;
        if (s === 0) {
          if (r < 15) break;
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        blk[off + ZIGZAG[k]] = reader.receiveExtend(s);
        k++;
      }
      return;
    }
    if (ss === 0) {
      if (ah === 0) {
        const t = reader.decode(c.dcTable!);
        c.pred += reader.receiveExtend(t);
        blk[off] = c.pred * (1 << al);
      } else if (reader.bit()) {
        blk[off] |= 1 << al;
      }
      return;
    }
    const ac = c.acTable!;
    if (ah === 0) {
      if (eob.run > 0) {
        eob.run--;
        return;
      }
      for (let k = ss; k <= se; ) {
        const rs = reader.decode(ac);
        const s = rs & 15;
        const r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            eob.run = (1 << r) - 1;
            if (r) eob.run += reader.bitsU(r);
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        blk[off + ZIGZAG[k]] = reader.receiveExtend(s) * (1 << al);
        k++;
      }
      return;
    }
    // Successive approximation refinement of AC coefficients (libjpeg's decode_mcu_AC_refine).
    const p1 = 1 << al;
    const m1 = -1 << al;
    let k = ss;
    if (eob.run === 0) {
      for (; k <= se; k++) {
        const rs = reader.decode(ac);
        let r = rs >> 4;
        let s = rs & 15;
        if (s) {
          s = reader.bit() ? p1 : m1;
        } else if (r !== 15) {
          eob.run = 1 << r;
          if (r) eob.run += reader.bitsU(r);
          break;
        }
        while (k <= se) {
          const z = off + ZIGZAG[k];
          if (blk[z] !== 0) {
            if (reader.bit() && (blk[z] & p1) === 0) blk[z] += blk[z] >= 0 ? p1 : m1;
          } else {
            if (--r < 0) break;
          }
          k++;
        }
        if (s && k <= 63) blk[off + ZIGZAG[k]] = s;
      }
    }
    if (eob.run > 0) {
      for (; k <= se; k++) {
        const z = off + ZIGZAG[k];
        if (blk[z] !== 0 && reader.bit() && (blk[z] & p1) === 0) blk[z] += blk[z] >= 0 ? p1 : m1;
      }
      eob.run--;
    }
  }

  /** Decodes MCU `mcu` of an interleaved scan (or block `mcu` of a single-channel one). */
  private decodeMcu(scan: Scan, reader: BitReader, mcu: number, eob: { run: number }) {
    if (scan.comps.length === 1) {
      const c = scan.comps[0];
      const row = Math.floor(mcu / c.bpl);
      const col = mcu - row * c.bpl;
      const [blk, off] = this.block(c, row, col);
      this.decodeBlock(scan, reader, c, blk, off, eob);
      return;
    }
    const mr = Math.floor(mcu / this.mcusPerLine);
    const mc = mcu - mr * this.mcusPerLine;
    for (const c of scan.comps) {
      for (let v = 0; v < c.v; v++) {
        for (let h = 0; h < c.h; h++) {
          const [blk, off] = this.block(c, mr * c.v + v, mc * c.h + h);
          this.decodeBlock(scan, reader, c, blk, off, eob);
        }
      }
    }
  }

  private scanMcuCount(scan: Scan) {
    if (scan.comps.length === 1) return scan.comps[0].bpl * scan.comps[0].bpc;
    return this.mcusPerLine * this.mcusPerColumn;
  }

  /** Decodes MCUs [from, to) of a scan, handling restart markers. */
  private decodeRange(scan: Scan, reader: BitReader, from: number, to: number, eob: { run: number }) {
    const ri = this.restartInterval;
    for (let m = from; m < to; m++) {
      if (ri && m > 0 && m % ri === 0) {
        reader.restart();
        for (const c of scan.comps) c.pred = 0;
        eob.run = 0;
      }
      this.decodeMcu(scan, reader, m, eob);
    }
  }

  private decodeWholeScan(scan: Scan): number {
    this.decodedAny = true;
    for (const c of scan.comps) c.pred = 0;
    const reader = new BitReader(this.d, scan.start);
    this.decodeRange(scan, reader, 0, this.scanMcuCount(scan), { run: 0 });
    return reader.scanEnd();
  }

  private streamEob = { run: 0 };

  /** Makes sure MCU row `r`'s coefficients are decoded (streaming mode decodes on demand). */
  private ensureDecoded(r: number) {
    const st = this.streaming;
    if (!st) return;
    while (this.decodedRows <= r && this.decodedRows < this.mcusPerColumn) {
      const single = st.scan.comps.length === 1;
      const c0 = st.scan.comps[0];
      for (const c of this.comps) c.rows[0].fill(0);
      if (single) {
        // One channel: blocks are in raster order over the real block grid.
        const from = this.decodedRows * c0.bpl;
        this.decodeRange(st.scan, st.reader, from, Math.min(from + c0.bpl, c0.bpl * c0.bpc), this.streamEob);
      } else {
        const from = this.decodedRows * this.mcusPerLine;
        this.decodeRange(st.scan, st.reader, from, from + this.mcusPerLine, this.streamEob);
      }
      this.toSamples(this.decodedRows);
      this.decodedRows++;
      this.sampledRows = this.decodedRows;
    }
  }

  /** Inverse-DCTs MCU row `r` into its slot in each component's plane ring. */
  private toSamples(r: number) {
    for (const c of this.comps) {
      const q = this.qt[c.tq];
      if (!q) throw new JpegError('Damaged JPEG: a quantisation table is missing.');
      const store = c.rows.length === 1 ? c.rows[0] : c.rows[r];
      const plane = c.planes[r % 3];
      for (let v = 0; v < c.v; v++) {
        for (let b = 0; b < c.bplPadded; b++) {
          idct(store, (v * c.bplPadded + b) * 64, q, plane, v * 8 * c.stride + b * 8, c.stride, this.tmp);
        }
      }
    }
  }

  private ensureSampled(r: number) {
    if (r >= this.mcusPerColumn) return;
    if (this.streaming) {
      this.ensureDecoded(r);
      return;
    }
    while (this.sampledRows <= r) {
      this.toSamples(this.sampledRows);
      // Coefficients of rows two behind are no longer needed.
      if (this.sampledRows >= 2) for (const c of this.comps) c.rows[this.sampledRows - 2] = new Int16Array(0);
      this.sampledRows++;
    }
  }

  /** Component sample line `y` (component coordinates), clamped to the picture. */
  private compLine(c: Component, y: number): [Uint8ClampedArray, number] {
    const yy = Math.max(0, Math.min(c.ch - 1, y));
    const r = Math.floor(yy / (8 * c.v));
    return [c.planes[r % 3], (yy - r * 8 * c.v) * c.stride];
  }

  /**
   * Writes the next `count` picture lines as RGBA into `out` (starting at line `outRow` of an
   * image `this.width` wide). Returns the number of lines written (fewer at the bottom).
   */
  readLines(out: Uint8ClampedArray, outRow: number, count: number): number {
    const W = this.width;
    const n = Math.min(count, this.height - this.line);
    const lineH = 8 * this.vmax;
    const comps = this.comps;
    const nc = comps.length;
    const rgbDirect = nc === 3 && (this.adobe === 0 || (this.adobe === null && !this.jfif && comps[0].id === 0x52 && comps[1].id === 0x47 && comps[2].id === 0x42));
    const ycck = nc === 4 && this.adobe === 2;
    const lines: [Uint8ClampedArray, number][] = new Array(nc);
    const lines2: [Uint8ClampedArray, number][] = new Array(nc);
    const wy = new Int32Array(nc);
    const rowBuf = (this.rowBuf ??= comps.map(() => new Uint8Array(W)));
    const vline = (this.vline ??= comps.map((c) => new Int32Array(c.cw)));
    // Four bytes per pixel in one store (every platform we ship on is little-endian).
    const px = out.byteOffset % 4 === 0 ? new Uint32Array(out.buffer, out.byteOffset, out.length >> 2) : null;
    for (let k = 0; k < n; k++) {
      const y = this.line + k;
      // Lines near the bottom of an MCU row interpolate with the next row: have it ready.
      const mr = Math.floor(y / lineH);
      this.ensureSampled(Math.min(this.mcusPerColumn - 1, mr + 1));
      for (let ci = 0; ci < nc; ci++) {
        const c = comps[ci];
        if (c.v === this.vmax) {
          lines[ci] = this.compLine(c, y);
          wy[ci] = 0;
        } else {
          const p = Math.max(0, ((y + 0.5) * c.v) / this.vmax - 0.5);
          const a = Math.floor(p);
          lines[ci] = this.compLine(c, a);
          lines2[ci] = this.compLine(c, a + 1);
          wy[ci] = Math.round((p - a) * 256);
        }
        // Vertical blend first (at the channel's own width), then widen to the full line. Integer
        // weights out of 256: exact for the usual 2× (¾ + ¼) and much faster than floats.
        const [pl, po] = lines[ci];
        const dst = rowBuf[ci];
        const w = wy[ci];
        if (!w) {
          if (c.h === this.hmax) {
            dst.set(pl.subarray(po, po + W));
          } else if (c.h * 2 === this.hmax) {
            widen2(pl, po, c.cw, dst, W, 2, 2);
          } else {
            const { i0, i1, w1 } = this.ups[ci];
            for (let x = 0; x < W; x++) {
              const l = pl[po + i0[x]];
              dst[x] = (l * 256 + (pl[po + i1[x]] - l) * w1[x] + 128) >> 8;
            }
          }
        } else {
          const [pl2, po2] = lines2[ci];
          const v = vline[ci];
          for (let x = 0; x < c.cw; x++) v[x] = pl[po + x] * 256 + (pl2[po2 + x] - pl[po + x]) * w;
          if (c.h === this.hmax) {
            for (let x = 0; x < W; x++) dst[x] = (v[x] + 128) >> 8;
          } else if (c.h * 2 === this.hmax) {
            // `v` is scaled by 256 from the vertical blend.
            widen2(v, 0, c.cw, dst, W, 10, 512);
          } else {
            const { i0, i1, w1 } = this.ups[ci];
            for (let x = 0; x < W; x++) {
              const l = v[i0[x]];
              dst[x] = (l * 256 + (v[i1[x]] - l) * w1[x] + 32768) >> 16;
            }
          }
        }
      }
      let o = (outRow + k) * W * 4;
      if (nc === 1) {
        const g = rowBuf[0];
        for (let x = 0; x < W; x++, o += 4) {
          out[o] = out[o + 1] = out[o + 2] = g[x];
          out[o + 3] = 255;
        }
      } else if (nc === 3) {
        const [Y, Cb, Cr] = rowBuf;
        if (rgbDirect) {
          for (let x = 0; x < W; x++, o += 4) {
            out[o] = Y[x];
            out[o + 1] = Cb[x];
            out[o + 2] = Cr[x];
            out[o + 3] = 255;
          }
        } else if (px) {
          // libjpeg's fixed-point YCbCr → RGB, one 32-bit store per pixel.
          let p = o >> 2;
          for (let x = 0; x < W; x++, p++) {
            const yy = Y[x] + CLAMP_OFFSET;
            const cb = Cb[x];
            const cr = Cr[x];
            px[p] =
              0xff000000 |
              (CLAMP[yy + CB_B[cb]] << 16) |
              (CLAMP[yy + ((CB_G[cb] + CR_G[cr]) >> 16)] << 8) |
              CLAMP[yy + CR_R[cr]];
          }
        } else {
          for (let x = 0; x < W; x++, o += 4) {
            const yy = Y[x];
            const cb = Cb[x] - 128;
            const cr = Cr[x] - 128;
            // `out` is a Uint8ClampedArray: stores clamp and round.
            out[o] = yy + 1.402 * cr;
            out[o + 1] = yy - 0.344136 * cb - 0.714136 * cr;
            out[o + 2] = yy + 1.772 * cb;
            out[o + 3] = 255;
          }
        }
      } else {
        const [A, B, C, K] = rowBuf;
        for (let x = 0; x < W; x++, o += 4) {
          let c = A[x];
          let m = B[x];
          let ye = C[x];
          if (ycck) {
            const cb = m - 128;
            const cr = ye - 128;
            const yy = c;
            c = 255 - clamp(yy + 1.402 * cr);
            m = 255 - clamp(yy - 0.344136 * cb - 0.714136 * cr);
            ye = 255 - clamp(yy + 1.772 * cb);
          }
          // Adobe stores CMYK inverted, so "value × K" gives the visible colour.
          const k = K[x] / 255;
          if (this.adobe !== null) {
            out[o] = c * k;
            out[o + 1] = m * k;
            out[o + 2] = ye * k;
          } else {
            out[o] = (255 - c) * (1 - K[x] / 255);
            out[o + 1] = (255 - m) * (1 - K[x] / 255);
            out[o + 2] = (255 - ye) * (1 - K[x] / 255);
          }
          out[o + 3] = 255;
        }
      }
    }
    this.line += n;
    return n;
  }
}

function clamp(v: number) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
