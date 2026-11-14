import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { encodeTable, optimalTable } from './jpeg-huffman.ts';
import { joinJpegStrips } from './jpeg-join.ts';
import { JpegStreamDecoder, readJpegInfo } from './jpeg-stream.ts';
import { AreaResizer, readAll, type LineSource } from './rows.ts';

// Fixtures: a 61×45 gradient saved by libjpeg (Pillow) in several flavours, plus the same picture
// cut into 16-row strips (baseline, standard Huffman tables, like the strips MozJPEG makes).
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const W = 61;
const H = 45;
const gradient = (x: number, y: number) => [x * 4, y * 5, Math.min(255, Math.max(0, 200 - x * 2 + y))];

function decode(bytes: Uint8Array, chunk = 7) {
  const d = new JpegStreamDecoder(bytes);
  const out = new Uint8ClampedArray(d.width * d.height * 4);
  let y = 0;
  // Odd chunk sizes, so reads cross MCU row boundaries.
  while (y < d.height) y += d.readLines(out, y, chunk);
  return { d, out };
}

/** Mean absolute difference over RGB. */
function meanDiff(a: ArrayLike<number>, b: ArrayLike<number>) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    sum += Math.abs(a[i] - b[i]);
    n++;
  }
  return sum / n;
}

function expected(grey = false) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = gradient(x, y);
      const o = (y * W + x) * 4;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      out.set(grey ? [l, l, l, 255] : [r, g, b, 255], o);
    }
  }
  return out;
}

test('reads the frame size without decoding', () => {
  assert.deepEqual(readJpegInfo(fixture('base420.jpg')), { width: W, height: H, components: 3, progressive: false });
  assert.deepEqual(readJpegInfo(fixture('prog420.jpg')), { width: W, height: H, components: 3, progressive: true });
  assert.equal(readJpegInfo(new Uint8Array([1, 2, 3])), null);
});

for (const [name, grey] of [
  ['base420.jpg', false],
  ['prog420.jpg', false],
  ['rst444.jpg', false],
  ['gray.jpg', true],
] as const) {
  test(`decodes ${name} close to the original picture`, () => {
    const { d, out } = decode(fixture(name));
    assert.equal(d.width, W);
    assert.equal(d.height, H);
    assert.ok(meanDiff(out, expected(grey)) < 3, `mean error ${meanDiff(out, expected(grey))}`);
    for (let i = 3; i < out.length; i += 4) assert.equal(out[i], 255);
  });
}

test('progressive and baseline decodes of the same picture agree', () => {
  assert.ok(meanDiff(decode(fixture('base420.jpg')).out, decode(fixture('prog420.jpg')).out) < 2);
});

function stacked(prefix: string) {
  const parts = [0, 1, 2].map((k) => decode(fixture(`${prefix}-${k}.jpg`)).out);
  const out = new Uint8ClampedArray(W * H * 4);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { parts: [0, 1, 2].map((k) => fixture(`${prefix}-${k}.jpg`)), out };
}

test('joining greyscale strips gives exactly the strips stacked, in a smaller file', () => {
  const { parts, out } = stacked('strip-gray');
  const joined = joinJpegStrips(parts);
  assert.deepEqual(readJpegInfo(joined), { width: W, height: H, components: 1, progressive: false });
  assert.deepEqual(decode(joined).out, out);
  assert.ok(joined.length < parts.reduce((n, p) => n + p.length, 0));
});

test('joining colour strips keeps the picture (chroma blends across the seams)', () => {
  const { parts, out } = stacked('strip-colour');
  const joined = joinJpegStrips(parts);
  assert.deepEqual(readJpegInfo(joined), { width: W, height: H, components: 3, progressive: false });
  assert.ok(meanDiff(decode(joined).out, out) < 1);
  assert.ok(meanDiff(decode(joined).out, expected()) < 4);
});

test('refuses strips that cannot be joined', () => {
  assert.throws(() => joinJpegStrips([fixture('strip-gray-0.jpg'), fixture('strip-colour-1.jpg')]));
  assert.throws(() => joinJpegStrips([fixture('prog420.jpg')]));
  // Only the last strip may have a height that isn't a whole number of block rows.
  assert.throws(() => joinJpegStrips([fixture('strip-gray-2.jpg'), fixture('strip-gray-0.jpg')]));
});

test('optimal Huffman tables are prefix-free and at most 16 bits', () => {
  const freq = new Float64Array(256);
  for (let i = 0; i < 256; i++) freq[i] = i < 40 ? 2 ** (i % 30) : i % 3;
  const t = optimalTable(freq);
  const { code, size } = encodeTable(t.counts, t.values);
  const used = [...t.values];
  for (const s of used) assert.ok(size[s] >= 1 && size[s] <= 16);
  for (const a of used) {
    for (const b of used) {
      if (a === b || size[a] > size[b]) continue;
      assert.notEqual(code[b] >> (size[b] - size[a]), code[a], `code ${a} is a prefix of ${b}`);
    }
  }
  // Every symbol that occurs gets a code; none of them is all ones.
  for (let i = 0; i < 256; i++) if (freq[i]) assert.ok(used.includes(i));
  for (const s of used) assert.notEqual(code[s], (1 << size[s]) - 1);
});

/** A line source over pixels in memory. */
function memory(data: Uint8ClampedArray, width: number, height: number): LineSource {
  let line = 0;
  return {
    width,
    height,
    readLines(out, outRow, count) {
      const n = Math.min(count, height - line);
      out.set(data.subarray(line * width * 4, (line + n) * width * 4), outRow * width * 4);
      line += n;
      return n;
    },
  };
}

test('area resizing averages in linear light', () => {
  // Black and white checkerboard → mid grey that looks as bright (188, not 128).
  const w = 64;
  const h = 48;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = ((i % w) + Math.floor(i / w)) % 2 ? 255 : 0;
    data.set([v, v, v, 255], i * 4);
  }
  const out = readAll(new AreaResizer(memory(data, w, h), 16, 12));
  assert.equal(out.length, 16 * 12 * 4);
  for (let i = 0; i < out.length; i += 4) {
    assert.ok(Math.abs(out[i] - 188) <= 1, `got ${out[i]}`);
    assert.equal(out[i + 3], 255);
  }
});

test('area resizing keeps flat colours and handles uneven scales', () => {
  const w = 101;
  const h = 37;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([200, 30, 90, 255], i * 4);
  const out = readAll(new AreaResizer(memory(data, w, h), 33, 10));
  for (let i = 0; i < out.length; i += 4) assert.deepEqual([...out.subarray(i, i + 4)], [200, 30, 90, 255]);
});
