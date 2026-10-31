// Zero-dependency PNG decode/encode and pixel comparison for visual regression.
// Handles what Playwright screenshots produce: 8-bit, non-interlaced, colour type 2 (RGB) or 6 (RGBA).
import zlib from 'node:zlib';

export function decodePng(buffer) {
  if (buffer.length < 33 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error('不是 PNG 文件');
  let offset = 8, width = 0, height = 0, channels = 0; const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('latin1', offset + 4, offset + 8), chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      if (chunk[8] !== 8 || ![2, 6].includes(chunk[9]) || chunk[12] !== 0) throw new Error('只支持 8 位、非隔行的 RGB/RGBA PNG');
      channels = chunk[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') data.push(chunk);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!width || !height) throw new Error('PNG 缺少 IHDR');
  const raw = zlib.inflateSync(Buffer.concat(data)), stride = width * channels, rgba = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0, up = previous[x], upLeft = x >= channels ? previous[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left; else if (filter === 2) predictor = up; else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) { const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft); predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft; }
      else if (filter !== 0) throw new Error('未知的 PNG 滤波器');
      line[x] = (line[x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels, to = (y * width + x) * 4;
      rgba[to] = line[from]; rgba[to + 1] = line[from + 1]; rgba[to + 2] = line[from + 2]; rgba[to + 3] = channels === 4 ? line[from + 3] : 255;
    }
    previous = line;
  }
  return { width, height, data: rgba };
}

export function encodePng({ width, height, data }) {
  const chunk = (type, body) => { const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'latin1'); const tail = Buffer.alloc(4); tail.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0); return Buffer.concat([head, body, tail]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) data.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// A pixel differs when any channel differs by more than `threshold` (0..1). Size mismatch is a total mismatch.
export function comparePng(expectedBuffer, actualBuffer, { threshold = 0.1, maxDiffRatio = 0.0001 } = {}) {
  const expected = decodePng(expectedBuffer), actual = decodePng(actualBuffer);
  if (expected.width !== actual.width || expected.height !== actual.height) return { same: false, ratio: 1, diffPixels: Math.max(expected.width * expected.height, actual.width * actual.height), reason: `尺寸不同：${expected.width}×${expected.height} 与 ${actual.width}×${actual.height}`, diff: null };
  const limit = threshold * 255, diff = Buffer.alloc(expected.data.length); let diffPixels = 0;
  for (let index = 0; index < expected.data.length; index += 4) {
    const different = [0, 1, 2, 3].some(channel => Math.abs(expected.data[index + channel] - actual.data[index + channel]) > limit);
    if (different) { diffPixels++; diff[index] = 220; diff[index + 1] = 40; diff[index + 2] = 40; diff[index + 3] = 255; }
    else { const gray = Math.round((expected.data[index] + expected.data[index + 1] + expected.data[index + 2]) / 3 * 0.35 + 165); diff[index] = diff[index + 1] = diff[index + 2] = gray; diff[index + 3] = 255; }
  }
  const ratio = diffPixels / (expected.width * expected.height);
  return { same: ratio <= maxDiffRatio, ratio, diffPixels, diff: { width: expected.width, height: expected.height, data: diff } };
}
