import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes, formatSaving, outputName, splitName, targetDimensions, uniqueNames } from './format.ts';
import { ssim, proxyImage } from './ssim.ts';

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
  assert.equal(formatBytes(250 * 1024), '250 KB');
});

test('formatSaving', () => {
  assert.equal(formatSaving(1000, 180), '−82%');
  assert.equal(formatSaving(1000, 1040), '+4%');
  assert.equal(formatSaving(1000, 1000), '0%');
});

test('targetDimensions', () => {
  const r = { mode: 'fit' as const, width: 1920, height: 1080, percent: 50, noEnlarge: true };
  assert.deepEqual(targetDimensions(4000, 3000, r), { width: 1440, height: 1080 });
  assert.deepEqual(targetDimensions(800, 600, r), { width: 800, height: 600 });
  assert.deepEqual(targetDimensions(800, 600, { ...r, noEnlarge: false }), { width: 1440, height: 1080 });
  assert.deepEqual(targetDimensions(4000, 3000, { ...r, mode: 'width' }), { width: 1920, height: 1440 });
  assert.deepEqual(targetDimensions(4000, 3000, { ...r, mode: 'percent' }), { width: 2000, height: 1500 });
  assert.deepEqual(targetDimensions(4000, 3000, { ...r, mode: 'none' }), { width: 4000, height: 3000 });
  assert.deepEqual(targetDimensions(1, 1, { ...r, mode: 'percent', percent: 1 }), { width: 1, height: 1 });
});

test('outputName', () => {
  const vars = { width: 800, height: 600, quality: 78.4, index: 2 };
  assert.equal(outputName('{name}', 'IMG_01.JPG', 'jpg', vars), 'IMG_01.jpg');
  assert.equal(outputName('{name}-min', 'a.b.png', 'webp', vars), 'a.b-min.webp');
  assert.equal(outputName('{name}_{w}x{h}_q{q}_{n}', 'x.heic', 'jpg', vars), 'x_800x600_q78_3.jpg');
  assert.equal(outputName('../{name}', 'x.jpg', 'jpg', vars), '_x.jpg');
  assert.equal(outputName('', 'x.jpg', 'jpg', vars), 'x.jpg');
  assert.equal(outputName('...', 'x.jpg', 'jpg', vars), 'image.jpg');
});

test('splitName', () => {
  assert.deepEqual(splitName('photo.final.JPG'), ['photo.final', 'JPG']);
  assert.deepEqual(splitName('.hidden'), ['.hidden', '']);
  assert.deepEqual(splitName('noext'), ['noext', '']);
});

test('uniqueNames', () => {
  assert.deepEqual(uniqueNames(['a.jpg', 'A.jpg', 'b.jpg', 'a.jpg', 'a (2).jpg']), [
    'a.jpg',
    'A (2).jpg',
    'b.jpg',
    'a (3).jpg',
    'a (2) (2).jpg',
  ]);
});

function img(w: number, h: number, f: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = f(x, y);
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { data, width: w, height: h };
}

test('ssim: identical is 1, noise lowers it, more noise lowers it more', () => {
  const base = img(64, 64, (x, y) => (x * 4 + y * 2) % 256);
  assert.equal(ssim(base, base), 1);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const noisy = (amp: number) => img(64, 64, (x, y) => (x * 4 + y * 2) % 256 + rnd() * amp);
  const a = ssim(base, noisy(4));
  const b = ssim(base, noisy(40));
  assert.ok(a < 1 && a > 0.9, `light noise ${a}`);
  assert.ok(b < a, `heavy noise ${b} < ${a}`);
  assert.throws(() => ssim(base, img(32, 32, () => 0)));
});

test('proxyImage keeps small images and tiles large ones', () => {
  const small = img(100, 100, () => 1);
  const make = (data: Uint8ClampedArray, width: number, height: number) => ({ data, width, height });
  assert.equal(proxyImage(small, make), small);
  const big = img(4000, 3000, (x) => x % 256);
  const p = proxyImage(big, make);
  assert.equal(p.width, 1536);
  assert.equal(p.height, 1536);
  // Tiles are copied at full resolution (a horizontal gradient stays a 1-step gradient).
  assert.equal(p.data[4] - p.data[0], 1);
});
