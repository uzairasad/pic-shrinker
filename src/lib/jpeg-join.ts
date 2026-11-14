/**
 * Joins JPEG strips (the same picture width, encoded one band of rows at a time with identical
 * settings) into one baseline JPEG, without decoding pixels: the entropy-coded data of every
 * strip is re-coded with DC prediction running across strip boundaries and one set of optimal
 * Huffman tables for the whole picture. The result is the same as encoding it in one go, apart
 * from progressive mode, which needs the whole picture at once.
 *
 * Strip heights must be multiples of the MCU height (16 rows covers every sampling factor we use),
 * except the last.
 */
import { BitReader, BitWriter, buildHuffman, category, encodeTable, JpegError, optimalTable, type HuffmanTable } from './jpeg-huffman.ts';

interface StripInfo {
  bytes: Uint8Array;
  width: number;
  height: number;
  comps: { id: number; h: number; v: number; tq: number }[];
  /** Per scan component: DC and AC table ids. */
  scanTables: { td: number; ta: number }[];
  dc: HuffmanTable[];
  ac: HuffmanTable[];
  restartInterval: number;
  dqt: Uint8Array[];
  sos: Uint8Array;
  dataStart: number;
  /** Everything before the first DQT/SOF (SOI + APPn), copied into the result. */
  head: Uint8Array;
}

function u16(d: Uint8Array, i: number) {
  return (d[i] << 8) | d[i + 1];
}

function parseStrip(d: Uint8Array): StripInfo {
  if (d[0] !== 0xff || d[1] !== 0xd8) throw new JpegError('Strip is not a JPEG.');
  const info: Partial<StripInfo> & { dc: HuffmanTable[]; ac: HuffmanTable[]; dqt: Uint8Array[] } = {
    bytes: d,
    dc: [],
    ac: [],
    dqt: [],
    restartInterval: 0,
  };
  let headEnd = -1;
  let i = 2;
  while (i + 4 <= d.length) {
    if (d[i] !== 0xff) throw new JpegError('Strip has a damaged header.');
    const m = d[i + 1];
    const len = u16(d, i + 2);
    const p = i + 4;
    if (m !== 0xe0 && m !== 0xfe && !(m >= 0xe1 && m <= 0xef) && headEnd < 0) headEnd = i;
    if (m === 0xdb) info.dqt.push(d.subarray(i, i + 2 + len));
    else if (m === 0xc4) {
      let k = p;
      while (k < i + 2 + len) {
        const tc = d[k] >> 4;
        const th = d[k] & 15;
        let n = 0;
        for (let j = 0; j < 16; j++) n += d[k + 1 + j];
        (tc ? info.ac : info.dc)[th] = buildHuffman(d.subarray(k + 1, k + 17), d.slice(k + 17, k + 17 + n));
        k += 17 + n;
      }
    } else if (m === 0xdd) info.restartInterval = u16(d, p);
    else if (m === 0xc0 || m === 0xc1) {
      info.height = u16(d, p + 1);
      info.width = u16(d, p + 3);
      info.comps = [];
      for (let c = 0; c < d[p + 5]; c++) {
        const o = p + 6 + c * 3;
        info.comps.push({ id: d[o], h: d[o + 1] >> 4, v: d[o + 1] & 15, tq: d[o + 2] });
      }
    } else if (m === 0xc2) {
      throw new JpegError('Strips must be baseline JPEGs.');
    } else if (m === 0xda) {
      const n = d[p];
      if (!info.comps || n !== info.comps.length) throw new JpegError('Strips must have one interleaved scan.');
      info.scanTables = [];
      for (let k = 0; k < n; k++) {
        if (d[p + 1 + k * 2] !== info.comps[k].id) throw new JpegError('Strip scan order differs from its frame.');
        const t = d[p + 2 + k * 2];
        info.scanTables.push({ td: t >> 4, ta: t & 15 });
      }
      info.sos = d.subarray(i, i + 2 + len);
      info.dataStart = i + 2 + len;
      info.head = d.subarray(0, headEnd < 0 ? i : headEnd);
      return info as StripInfo;
    }
    i += 2 + len;
  }
  throw new JpegError('Strip has no image data.');
}

/** Walks every block of a strip, calling back with the DC value and the AC symbols. */
function walkStrip(
  s: StripInfo,
  onDc: (comp: number, dc: number) => void,
  onAc: (comp: number, rs: number, bits: number) => void,
) {
  const hmax = Math.max(...s.comps.map((c) => c.h));
  const vmax = Math.max(...s.comps.map((c) => c.v));
  const single = s.comps.length === 1;
  const mcus = single
    ? Math.ceil(s.width / 8) * Math.ceil(s.height / 8)
    : Math.ceil(s.width / (8 * hmax)) * Math.ceil(s.height / (8 * vmax));
  const reader = new BitReader(s.bytes, s.dataStart);
  const pred = new Int32Array(s.comps.length);
  const ri = s.restartInterval;
  for (let m = 0; m < mcus; m++) {
    if (ri && m > 0 && m % ri === 0) {
      reader.restart();
      pred.fill(0);
    }
    for (let ci = 0; ci < s.comps.length; ci++) {
      const c = s.comps[ci];
      const dcT = s.dc[s.scanTables[ci].td];
      const acT = s.ac[s.scanTables[ci].ta];
      const blocks = single ? 1 : c.h * c.v;
      for (let b = 0; b < blocks; b++) {
        const t = reader.decode(dcT);
        pred[ci] += reader.receiveExtend(t);
        onDc(ci, pred[ci]);
        for (let k = 1; k < 64; ) {
          const rs = reader.decode(acT);
          const sz = rs & 15;
          const r = rs >> 4;
          if (sz === 0) {
            onAc(ci, rs, 0);
            if (r < 15) break;
            k += 16;
            continue;
          }
          onAc(ci, rs, reader.bitsU(sz));
          k += r + 1;
        }
      }
    }
  }
  // A strip whose data doesn't fit its size would turn into stripes of noise in the joined file
  // (0.2.2 shipped such files when MozJPEG's Huffman tables were missing codes): refuse it.
  if (!reader.endsCleanly()) throw new JpegError('A band of the picture was encoded incorrectly.');
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 4);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (payload.length + 2) >> 8;
  out[3] = (payload.length + 2) & 0xff;
  out.set(payload, 4);
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Symbol counts of one strip, gathered where the strip was encoded (in parallel) so the join only
 * has to read the strips once. DC differences are counted as if each strip started from zero;
 * `first`/`last` DC values let the join correct the first block of every strip.
 */
export interface StripStats {
  dc: Float64Array[];
  ac: Float64Array[];
  first: Int32Array;
  last: Int32Array;
}

/** Table slot per component: luma (0) or chroma (1). */
const slotOf = (ci: number) => (ci === 0 ? 0 : 1);

/** Null when the strip can't be counted on its own (restart markers reset DC prediction). */
export function stripStats(bytes: Uint8Array): StripStats | null {
  const s = parseStrip(bytes);
  if (s.restartInterval) return null;
  const n = s.comps.length;
  const slots = n > 1 ? 2 : 1;
  const stats: StripStats = {
    dc: Array.from({ length: slots }, () => new Float64Array(256)),
    ac: Array.from({ length: slots }, () => new Float64Array(256)),
    first: new Int32Array(n),
    last: new Int32Array(n),
  };
  const seen = new Uint8Array(n);
  walkStrip(
    s,
    (ci, dc) => {
      stats.dc[slotOf(ci)][category(dc - stats.last[ci])]++;
      if (!seen[ci]) ((seen[ci] = 1), (stats.first[ci] = dc));
      stats.last[ci] = dc;
    },
    (ci, rs) => {
      stats.ac[slotOf(ci)][rs]++;
    },
  );
  return stats;
}

/**
 * One JPEG of the strips stacked top to bottom. With `stats` for every strip (from stripStats),
 * the strips are read once instead of twice.
 */
export function joinJpegStrips(strips: Uint8Array[], stats?: (StripStats | null)[]): Uint8Array {
  if (!strips.length) throw new JpegError('Nothing to join.');
  const infos = strips.map(parseStrip);
  const first = infos[0];
  const totalHeight = infos.reduce((n, s) => n + s.height, 0);
  if (totalHeight > 65535) throw new JpegError('JPEG pictures can be at most 65,535 pixels tall.');
  const vmax = Math.max(...first.comps.map((c) => c.v));
  for (const [k, s] of infos.entries()) {
    const ok =
      s.width === first.width &&
      s.comps.length === first.comps.length &&
      s.comps.every((c, i) => c.h === first.comps[i].h && c.v === first.comps[i].v && c.tq === first.comps[i].tq) &&
      s.dqt.length === first.dqt.length &&
      s.dqt.every((q, i) => sameBytes(q, first.dqt[i]));
    if (!ok) throw new JpegError('Strips were encoded differently and cannot be joined.');
    if (k < infos.length - 1 && s.height % (8 * vmax)) throw new JpegError('Strip height must be a multiple of the block height.');
  }

  // Table slot per component: luma (0) or chroma (1), like the strips use.
  const slot = first.comps.map((_, i) => (i === 0 ? 0 : 1));
  const nSlots = first.comps.length > 1 ? 2 : 1;
  const dcFreq = Array.from({ length: nSlots }, () => new Float64Array(256));
  const acFreq = Array.from({ length: nSlots }, () => new Float64Array(256));

  // Pass 1: symbol statistics (already counted per strip, or counted here).
  if (stats && stats.length === infos.length && stats.every((x) => x && x.dc.length === nSlots)) {
    const all = stats as StripStats[];
    all.forEach((st, k) => {
      for (let i = 0; i < nSlots; i++) {
        for (let v = 0; v < 256; v++) {
          dcFreq[i][v] += st.dc[i][v];
          acFreq[i][v] += st.ac[i][v];
        }
      }
      if (k === 0) return;
      // The strip counted its first block against 0; in the joined file it follows the last
      // block of the strip above.
      for (let ci = 0; ci < first.comps.length; ci++) {
        dcFreq[slot[ci]][category(st.first[ci])]--;
        dcFreq[slot[ci]][category(st.first[ci] - all[k - 1].last[ci])]++;
      }
    });
  } else {
    const gpred = new Int32Array(first.comps.length);
    for (const s of infos) {
      walkStrip(
        s,
        (ci, dc) => {
          dcFreq[slot[ci]][category(dc - gpred[ci])]++;
          gpred[ci] = dc;
        },
        (ci, rs) => {
          acFreq[slot[ci]][rs]++;
        },
      );
    }
  }
  const dcTables = dcFreq.map(optimalTable);
  const acTables = acFreq.map(optimalTable);
  const dcCodes = dcTables.map((t) => encodeTable(t.counts, t.values));
  const acCodes = acTables.map((t) => encodeTable(t.counts, t.values));

  // Pass 2: write.
  const estimate = infos.reduce((n, s) => n + s.bytes.length, 0);
  const w = new BitWriter(Math.ceil(estimate * 1.05) + 4096);
  {
    const gpred = new Int32Array(first.comps.length);
    for (const s of infos) {
      walkStrip(
        s,
        (ci, dc) => {
          const diff = dc - gpred[ci];
          gpred[ci] = dc;
          const cat = category(diff);
          const t = dcCodes[slot[ci]];
          w.put(t.code[cat], t.size[cat]);
          if (cat) w.put(diff < 0 ? diff + (1 << cat) - 1 : diff, cat);
        },
        (ci, rs, bits) => {
          const t = acCodes[slot[ci]];
          w.put(t.code[rs], t.size[rs]);
          if (rs & 15) w.put(bits, rs & 15);
        },
      );
    }
  }
  const data = w.finish();

  // Headers: the first strip's APPn and quantisation tables, a frame header with the full
  // height, the new Huffman tables and a scan header pointing at them.
  const sofPayload = new Uint8Array(6 + first.comps.length * 3);
  sofPayload[0] = 8;
  sofPayload[1] = totalHeight >> 8;
  sofPayload[2] = totalHeight & 0xff;
  sofPayload[3] = first.width >> 8;
  sofPayload[4] = first.width & 0xff;
  sofPayload[5] = first.comps.length;
  first.comps.forEach((c, i) => {
    sofPayload[6 + i * 3] = c.id;
    sofPayload[7 + i * 3] = (c.h << 4) | c.v;
    sofPayload[8 + i * 3] = c.tq;
  });
  const dht: number[] = [];
  for (let k = 0; k < nSlots; k++) {
    for (const [tc, t] of [
      [0, dcTables[k]],
      [1, acTables[k]],
    ] as const) {
      dht.push((tc << 4) | k, ...t.counts, ...t.values);
    }
  }
  const sosPayload = new Uint8Array(4 + first.comps.length * 2);
  sosPayload[0] = first.comps.length;
  first.comps.forEach((c, i) => {
    sosPayload[1 + i * 2] = c.id;
    sosPayload[2 + i * 2] = (slot[i] << 4) | slot[i];
  });
  sosPayload[1 + first.comps.length * 2] = 0;
  sosPayload[2 + first.comps.length * 2] = 63;
  sosPayload[3 + first.comps.length * 2] = 0;

  const parts = [first.head, ...first.dqt, segment(0xc0, sofPayload), segment(0xc4, Uint8Array.from(dht)), segment(0xda, sosPayload), data, Uint8Array.of(0xff, 0xd9)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
