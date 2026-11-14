/**
 * Shared JPEG entropy-coding pieces: zig-zag order, a fast bit reader, Huffman decode tables,
 * and optimal Huffman table construction (ITU T.81 Annex K.2, as libjpeg does it). Used by the
 * streaming decoder (jpeg-stream.ts) and by the strip joiner (jpeg-join.ts).
 */

/** Zig-zag index → natural (row-major) index in an 8×8 block. */
export const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49,
  56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

export interface HuffmanTable {
  /** 9-bit lookahead: (code length << 8) | symbol, or 0 when the code is longer than 9 bits. */
  fast: Int32Array;
  /** Largest code of each length (−1 when there is none), index 1–16. */
  maxCode: Int32Array;
  /** Added to a code of length l to find its symbol's index in `values`. */
  valOffset: Int32Array;
  values: Uint8Array;
  /** As stored in the file (DHT), for writing it back out. */
  counts: Uint8Array;
}

const FAST_BITS = 9;

export function buildHuffman(counts: ArrayLike<number>, values: Uint8Array): HuffmanTable {
  const fast = new Int32Array(1 << FAST_BITS);
  const maxCode = new Int32Array(18).fill(-1);
  const valOffset = new Int32Array(18);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const n = counts[len - 1];
    valOffset[len] = k - code;
    for (let i = 0; i < n; i++, k++, code++) {
      if (len <= FAST_BITS) {
        const shift = FAST_BITS - len;
        const base = code << shift;
        for (let j = 0; j < 1 << shift; j++) fast[base + j] = (len << 8) | values[k];
      }
    }
    if (n) maxCode[len] = code - 1;
    code <<= 1;
  }
  return { fast, maxCode, valOffset, values, counts: Uint8Array.from(counts) };
}

/** Thrown when the data can't be a JPEG we can read. */
export class JpegError extends Error {}

/**
 * Reads entropy-coded bits, undoing 0xFF00 byte stuffing. At a marker it stops consuming and
 * feeds zero bits, so a truncated or damaged file decodes as far as it goes.
 */
export class BitReader {
  pos: number;
  private data: Uint8Array;
  private end: number;
  private acc = 0;
  private bits = 0;
  /** Set once a marker (or the end of the data) was reached. */
  atMarker = false;

  constructor(data: Uint8Array, start: number, end = data.length) {
    this.data = data;
    this.end = end;
    this.pos = start;
  }

  private fill() {
    const d = this.data;
    while (this.bits <= 24) {
      let b = 0;
      if (!this.atMarker && this.pos < this.end) {
        b = d[this.pos];
        if (b === 0xff) {
          const next = this.pos + 1 < this.end ? d[this.pos + 1] : 0xd9;
          if (next === 0) {
            this.pos += 2;
          } else {
            this.atMarker = true;
            b = 0;
          }
        } else {
          this.pos++;
        }
      } else {
        this.atMarker = true;
      }
      this.acc = (this.acc << 8) | b;
      this.bits += 8;
    }
  }

  /** `n` (1–16) bits as an unsigned number. */
  bitsU(n: number): number {
    if (this.bits < n) this.fill();
    this.bits -= n;
    return (this.acc >>> this.bits) & ((1 << n) - 1);
  }

  bit(): number {
    return this.bitsU(1);
  }

  /** `n` bits, sign-extended the JPEG way (n = 0 gives 0). */
  receiveExtend(n: number): number {
    if (n === 0) return 0;
    const v = this.bitsU(n);
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  }

  decode(t: HuffmanTable): number {
    if (this.bits < 16) this.fill();
    const e = t.fast[(this.acc >>> (this.bits - FAST_BITS)) & ((1 << FAST_BITS) - 1)];
    if (e) {
      this.bits -= e >> 8;
      return e & 0xff;
    }
    for (let len = FAST_BITS + 1; len <= 16; len++) {
      const code = (this.acc >>> (this.bits - len)) & ((1 << len) - 1);
      if (code <= t.maxCode[len]) {
        this.bits -= len;
        return t.values[code + t.valOffset[len]];
      }
    }
    // Not a valid code: damaged data. Skip a bit so decoding keeps moving.
    this.bits -= 1;
    return 0;
  }

  /** Drops buffered bits and moves past the next RSTn marker (restart interval boundary). */
  restart() {
    this.acc = 0;
    this.bits = 0;
    this.atMarker = false;
    const d = this.data;
    let p = this.pos;
    while (p + 1 < this.end && !(d[p] === 0xff && d[p + 1] >= 0xd0 && d[p + 1] <= 0xd7)) {
      // Only skip over padding; stop at any other marker.
      if (d[p] === 0xff && d[p + 1] !== 0 && d[p + 1] !== 0xff) break;
      p++;
    }
    if (p + 1 < this.end && d[p] === 0xff && d[p + 1] >= 0xd0 && d[p + 1] <= 0xd7) p += 2;
    this.pos = p;
  }

  /** Position of the marker that ends this scan. */
  scanEnd(): number {
    const d = this.data;
    let p = this.pos;
    while (p + 1 < this.end && !(d[p] === 0xff && d[p + 1] !== 0 && d[p + 1] !== 0xff && !(d[p + 1] >= 0xd0 && d[p + 1] <= 0xd7))) p++;
    return p;
  }
}

/** Writes entropy-coded bits with 0xFF00 stuffing into a growing buffer. */
export class BitWriter {
  private buf: Uint8Array;
  length = 0;
  private acc = 0;
  private bits = 0;

  constructor(capacity = 1 << 20) {
    this.buf = new Uint8Array(capacity);
  }

  private byte(b: number) {
    if (this.length + 2 > this.buf.length) {
      const bigger = new Uint8Array(Math.ceil(this.buf.length * 1.5) + 1024);
      bigger.set(this.buf.subarray(0, this.length));
      this.buf = bigger;
    }
    this.buf[this.length++] = b;
    if (b === 0xff) this.buf[this.length++] = 0;
  }

  /** Appends the low `n` (0–24) bits of `value`. */
  put(value: number, n: number) {
    if (n === 0) return;
    this.acc = (this.acc << n) | (value & ((1 << n) - 1));
    this.bits += n;
    while (this.bits >= 8) {
      this.bits -= 8;
      this.byte((this.acc >>> this.bits) & 0xff);
    }
    this.acc &= (1 << this.bits) - 1;
  }

  /** Pads the last byte with 1 bits and returns everything written. */
  finish(): Uint8Array {
    if (this.bits > 0) this.put(0x7f, 8 - this.bits);
    return this.buf.subarray(0, this.length);
  }
}

/** Number of bits needed for |v| (the JPEG "category"). */
export function category(v: number): number {
  let a = v < 0 ? -v : v;
  let n = 0;
  while (a) {
    n++;
    a >>= 1;
  }
  return n;
}

/**
 * Optimal Huffman code lengths for symbol frequencies, limited to 16 bits, in DHT form
 * (counts per length + symbols). Follows libjpeg's jpeg_gen_optimal_table.
 */
export function optimalTable(freqIn: ArrayLike<number>): { counts: Uint8Array; values: Uint8Array } {
  const freq = new Float64Array(257);
  for (let i = 0; i < 256; i++) freq[i] = freqIn[i];
  freq[256] = 1; // reserved, so no code is all ones
  const codesize = new Int32Array(257);
  const others = new Int32Array(257).fill(-1);
  for (;;) {
    let c1 = -1;
    let v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) ((v = freq[i]), (c1 = i));
    let c2 = -1;
    v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) ((v = freq[i]), (c2 = i));
    if (c2 < 0) break;
    freq[c1] += freq[c2];
    freq[c2] = 0;
    codesize[c1]++;
    while (others[c1] >= 0) {
      c1 = others[c1];
      codesize[c1]++;
    }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) {
      c2 = others[c2];
      codesize[c2]++;
    }
  }
  const bits = new Int32Array(64);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
  for (let i = 63; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2;
      bits[i - 1]++;
      bits[j + 1] += 2;
      bits[j]--;
    }
  }
  let i = 16;
  while (i > 0 && bits[i] === 0) i--;
  bits[i]--; // drop the reserved symbol
  const values: number[] = [];
  for (let len = 1; len < 64; len++) for (let s = 0; s < 256; s++) if (codesize[s] === len) values.push(s);
  const counts = new Uint8Array(16);
  for (let len = 1; len <= 16; len++) counts[len - 1] = bits[len];
  return { counts, values: Uint8Array.from(values) };
}

/** Canonical codes for a DHT table: code and length per symbol. */
export function encodeTable(counts: ArrayLike<number>, values: ArrayLike<number>) {
  const code = new Int32Array(256);
  const size = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++, k++) {
      code[values[k]] = c++;
      size[values[k]] = len;
    }
    c <<= 1;
  }
  return { code, size };
}
