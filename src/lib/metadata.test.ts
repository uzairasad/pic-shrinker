import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanExif, insertSegments, readJpegMetadata, readOrientation, readSegments, rewriteJpegMetadata } from './metadata.ts';

/** A little-endian EXIF payload: IFD0 with Orientation, ExifIFD (pixel size) and a GPS IFD. */
function makeExif(orientation: number, le = true): Uint8Array {
  const buf = new ArrayBuffer(400);
  const v = new DataView(buf);
  const b = new Uint8Array(buf);
  b.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0);
  const T = 6;
  const u16 = (o: number, x: number) => v.setUint16(T + o, x, le);
  const u32 = (o: number, x: number) => v.setUint32(T + o, x, le);
  b.set(le ? [0x49, 0x49] : [0x4d, 0x4d], T);
  u16(2, 42);
  u32(4, 8);
  // IFD0 at 8: 3 entries.
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    u16(at, tag);
    u16(at + 2, type);
    u32(at + 4, count);
    if (type === 3 && count === 1) u16(at + 8, value);
    else u32(at + 8, value);
  };
  u16(8, 3);
  entry(10, 0x0112, 3, 1, orientation);
  entry(22, 0x8769, 4, 1, 100); // ExifIFD
  entry(34, 0x8825, 4, 1, 200); // GPS IFD
  u32(46, 0); // next IFD
  // ExifIFD at 100: PixelXDimension, PixelYDimension.
  u16(100, 2);
  entry(102, 0xa002, 4, 1, 4000);
  entry(114, 0xa003, 4, 1, 3000);
  u32(126, 0);
  // GPS IFD at 200: GPSLatitudeRef ("N"), GPSLatitude (3 rationals at 300).
  u16(200, 2);
  entry(202, 0x0001, 2, 2, 0x4e); // "N\0" inline
  entry(214, 0x0002, 5, 3, 300);
  u32(226, 0);
  for (let i = 0; i < 6; i++) u32(300 + i * 4, 33 + i);
  return b.subarray(0, T + 330);
}

function makeJpeg(segments: { marker: number; payload: Uint8Array }[]): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  for (const s of segments) {
    const len = s.payload.length + 2;
    parts.push(0xff, s.marker, len >> 8, len & 0xff, ...s.payload);
  }
  // A fake SOS and EOI: everything after SOS is image data.
  parts.push(0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9);
  return new Uint8Array(parts);
}

const jfif = new Uint8Array([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const icc = new Uint8Array([...'ICC_PROFILE\0'].map((c) => c.charCodeAt(0)).concat([1, 1, 9, 9, 9]));
const xmp = new Uint8Array([...'http://ns.adobe.com/xap/1.0/\0<x/>'].map((c) => c.charCodeAt(0)));

test('reads EXIF and ICC segments', () => {
  const exif = makeExif(6);
  const jpg = makeJpeg([
    { marker: 0xe0, payload: jfif },
    { marker: 0xe1, payload: exif },
    { marker: 0xe2, payload: icc },
  ]);
  const meta = readJpegMetadata(jpg);
  assert.deepEqual(meta.exif, exif);
  assert.equal(meta.icc.length, 1);
  assert.equal(readOrientation(meta.exif), 6);
});

for (const le of [true, false]) {
  test(`cleanExif resets orientation, updates size, removes GPS (${le ? 'II' : 'MM'})`, () => {
    const exif = makeExif(8, le);
    const out = cleanExif(exif, { removeGps: true, width: 800, height: 600 });
    assert.equal(readOrientation(out), 1);
    const v = new DataView(out.buffer, out.byteOffset);
    const T = 6;
    // IFD0 now has 2 entries and no GPS pointer.
    assert.equal(v.getUint16(T + 8, le), 2);
    const tags = [0, 1].map((k) => v.getUint16(T + 10 + k * 12, le));
    assert.deepEqual(tags, [0x0112, 0x8769]);
    assert.equal(v.getUint32(T + 10 + 2 * 12, le), 0, 'next-IFD offset moved up');
    // Pixel size updated.
    assert.equal(v.getUint32(T + 102 + 8, le), 800);
    assert.equal(v.getUint32(T + 114 + 8, le), 600);
    // Latitude values are gone.
    for (let i = 0; i < 6; i++) assert.equal(v.getUint32(T + 300 + i * 4, le), 0);
    // The original is untouched.
    assert.equal(readOrientation(exif), 8);
  });
}

test('cleanExif keeps GPS when asked', () => {
  const out = cleanExif(makeExif(1), { removeGps: false });
  const v = new DataView(out.buffer, out.byteOffset);
  assert.equal(v.getUint16(6 + 8, true), 3);
  assert.equal(v.getUint32(6 + 300, true), 33);
});

test('cleanExif tolerates garbage', () => {
  const junk = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2, 3]);
  assert.deepEqual(cleanExif(junk, { removeGps: true }), junk);
  assert.equal(readOrientation(junk), 1);
});

test('insertSegments places EXIF right after SOI and drops JFIF', () => {
  const encoded = makeJpeg([{ marker: 0xe0, payload: jfif }]);
  const exif = makeExif(1);
  const out = insertSegments(encoded, [
    { marker: 0xe1, payload: exif },
    { marker: 0xe2, payload: icc },
  ]);
  const segs = readSegments(out);
  assert.deepEqual(
    segs.map((s) => s.marker),
    [0xe1, 0xe2],
  );
  assert.deepEqual(segs[0].payload, exif);
  // Image data survives.
  assert.deepEqual([...out.subarray(-9)], [0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
});

test('insertSegments keeps JFIF when only a colour profile goes in', () => {
  const out = insertSegments(makeJpeg([{ marker: 0xe0, payload: jfif }]), [{ marker: 0xe2, payload: icc }]);
  assert.deepEqual(
    readSegments(out).map((s) => s.marker),
    [0xe0, 0xe2],
  );
});

test('rewriteJpegMetadata applies each policy without touching image data', () => {
  const jpg = makeJpeg([
    { marker: 0xe0, payload: jfif },
    { marker: 0xe1, payload: makeExif(6) },
    { marker: 0xe1, payload: xmp },
    { marker: 0xe2, payload: icc },
    { marker: 0xee, payload: new Uint8Array([0x41, 0x64, 0x6f, 0x62, 0x65]) }, // Adobe
    { marker: 0xfe, payload: new Uint8Array([0x68, 0x69]) }, // comment
  ]);
  const markers = (b: Uint8Array) => readSegments(b).map((s) => s.marker);
  assert.deepEqual(markers(rewriteJpegMetadata(jpg, 'strip')), [0xe0, 0xee]);
  assert.deepEqual(markers(rewriteJpegMetadata(jpg, 'icc')), [0xe0, 0xe2, 0xee]);
  const nogps = rewriteJpegMetadata(jpg, 'nogps');
  assert.deepEqual(markers(nogps), [0xe0, 0xe1, 0xe2, 0xee]);
  // Orientation stays: these pixels were not rotated.
  assert.equal(readOrientation(readJpegMetadata(nogps).exif), 6);
  assert.equal(rewriteJpegMetadata(jpg, 'keep'), jpg);
  for (const mode of ['strip', 'icc', 'nogps'] as const) {
    assert.deepEqual([...rewriteJpegMetadata(jpg, mode).subarray(-9)], [0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
  }
});
