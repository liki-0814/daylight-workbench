import { httpError } from './http.mjs';
import { maxImages, maxImageBytes, imageMimeTypes } from '../core/ai-images.js';

export function validateImages(input = []) {
  if (!Array.isArray(input) || input.length > maxImages) throw httpError(`最多粘贴 ${maxImages} 张图片`);
  let total = 0;
  return input.map(image => {
    if (!image || !imageMimeTypes.includes(image.mimeType) || typeof image.data !== 'string' || image.data.length > Math.ceil(maxImageBytes / 3) * 4 || image.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw httpError('图片格式无效，请粘贴 PNG、JPEG 或 WebP 图片');
    const bytes = Buffer.from(image.data, 'base64'); total += bytes.length;
    if (bytes.toString('base64') !== image.data) throw httpError('图片编码无效');
    if (total > maxImageBytes) throw httpError('图片总大小不能超过 2 MB');
    const valid = image.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : image.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw httpError('图片内容与格式不符，请重新复制图片');
    return { mimeType: image.mimeType, data: bytes.toString('base64') };
  });
}
