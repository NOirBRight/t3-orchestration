import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import jsQR from 'jsqr'; // Development dependency only; never imported by shipped code.
import { qrMatrix, qrPng, qrTerminal } from '../qr.mjs';

function decodePng(png) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = []; let width, height;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[9], 0); }
    if (type === 'IDAT') idat.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat)), pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width + 1)], 0);
    for (let x = 0; x < width; x++) { const value = raw[y * (width + 1) + x + 1], i = (y * width + x) * 4; pixels.set([value, value, value, 255], i); }
  }
  return jsQR(pixels, width, height)?.data;
}
test('independent jsQR decoder reads standard-library PNG and exact UTF-8 payload', () => {
  for (const text of ['http://machine.local:18780/?k=memory-only', 'https://example.test/?k=' + 'x'.repeat(43), 'https://example.test/中文/?k=memory-only', 'x'.repeat(271)]) assert.equal(decodePng(qrPng(qrMatrix(text))), text);
});
test('QR enforces byte capacity without including content in diagnostics', () => {
  assert.throws(() => qrMatrix('密'.repeat(91)), /capacity/);
  assert.equal(qrMatrix('x').length, 57);
  assert.doesNotMatch(qrTerminal(qrMatrix('synthetic-secret')), /synthetic-secret/);
});
