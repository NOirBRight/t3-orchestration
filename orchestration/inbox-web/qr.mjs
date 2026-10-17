// QR Model 2, version 10, error correction L, byte mode, mask 0.
// Fixed size keeps the encoder small; capacity is 271 UTF-8 bytes.
import { deflateSync } from 'node:zlib';

function multiply(a, b) {
  let result = 0;
  for (; b; b >>>= 1) { if (b & 1) result ^= a; a <<= 1; if (a & 256) a ^= 0x11d; }
  return result;
}
function parity(data, degree) {
  let generator = [1], root = 1;
  for (let i = 0; i < degree; i++, root = multiply(root, 2)) {
    const next = Array(generator.length + 1).fill(0);
    generator.forEach((value, j) => { next[j] ^= value; next[j + 1] ^= multiply(value, root); });
    generator = next;
  }
  const buffer = [...data, ...Array(degree).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = buffer[i];
    generator.forEach((value, j) => { buffer[i + j] ^= multiply(value, factor); });
  }
  return buffer.slice(-degree);
}
export function qrMatrix(text) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > 271) throw new Error('Login URL exceeds QR capacity (271 UTF-8 bytes); use a shorter public entry URL.');
  const bits = [];
  const append = (value, count) => { for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  append(4, 4); append(bytes.length, 16); bytes.forEach(value => append(value, 8));
  append(0, Math.min(4, 274 * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  for (let i = 0; data.length < 274; i++) data.push(i % 2 ? 0x11 : 0xec);
  let offset = 0;
  const blocks = [68, 68, 69, 69].map(length => { const block = data.slice(offset, offset += length); return { data: block, ecc: parity(block, 18) }; });
  const words = [];
  for (let i = 0; i < 69; i++) for (const block of blocks) if (i < block.data.length) words.push(block.data[i]);
  for (let i = 0; i < 18; i++) for (const block of blocks) words.push(block.ecc[i]);
  const size = 57, modules = Array.from({ length: size }, () => Array(size).fill(false));
  const fixed = modules.map(row => row.map(() => false));
  const set = (x, y, value) => { if (x >= 0 && y >= 0 && x < size && y < size) { modules[y][x] = Boolean(value); fixed[y][x] = true; } };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [53, 3], [3, 53]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
    }
  }
  for (const cy of [6, 28, 50]) for (const cx of [6, 28, 50]) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === 50) || (cx === 50 && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // L = 01; mask = 000; BCH format and version information.
  let remainder = 8;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const format = ((8 << 10) | remainder) ^ 0x5412;
  const bit = (value, i) => (value >>> i) & 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(format, i));
  set(8, 7, bit(format, 6)); set(8, 8, bit(format, 7)); set(7, 8, bit(format, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(format, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(format, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(format, i));
  set(8, size - 8, true);
  remainder = 10;
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  const version = (10 << 12) | remainder;
  for (let i = 0; i < 18; i++) { const a = size - 11 + i % 3, b = Math.floor(i / 3); set(a, b, bit(version, i)); set(b, a, bit(version, i)); }
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (!fixed[y][x]) { modules[y][x] = Boolean(bit(words[index >>> 3] || 0, 7 - (index & 7)) ^ ((x + y) % 2 === 0)); index++; }
      }
    }
  }
  return modules;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
export function qrPng(matrix, scale = 6) {
  const size = (matrix.length + 8) * scale;
  const raw = Buffer.alloc((size + 1) * size, 255);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0;
    for (let x = 0; x < size; x++) if (matrix[Math.floor(y / scale) - 4]?.[Math.floor(x / scale) - 4]) raw[y * (size + 1) + x + 1] = 0;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function qrTerminal(matrix) {
  const get = (x, y) => Boolean(matrix[y - 4]?.[x - 4]);
  let result = '\x1b[30;47m';
  for (let y = 0; y < matrix.length + 8; y += 2) {
    for (let x = 0; x < matrix.length + 8; x++) result += [' ', '▀', '▄', '█'][Number(get(x, y)) + 2 * Number(get(x, y + 1))];
    result += '\n';
  }
  return result + '\x1b[0m';
}
