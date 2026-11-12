import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);

export function imageDimensions(bytes) {
  if (bytes.length > 8 * 1024 * 1024) throw new Error('OCR image byte limit');
  let width, height;
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.length >= 24 &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) throw new Error('invalid JPEG markers');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('invalid JPEG segment');
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        length >= 8
      ) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else throw new Error('OCR image format must be PNG or JPEG');
  if (!width || !height || width > 4096 || height > 4096 || width * height > 4 * 1024 * 1024)
    throw new Error('OCR image pixel limit');
  return { width, height };
}
export async function createOfflineOcr() {
  const { createWorker } = await import('tesseract.js');
  const model = require.resolve('@tesseract.js-data/eng');
  const worker = await createWorker('eng', 1, {
    langPath: join(dirname(model), '4.0.0_best_int'),
    gzip: true,
    workerPath: require.resolve('tesseract.js/src/worker-script/node/index.js'),
    corePath: require.resolve('tesseract.js-core/tesseract-core.wasm.js'),
    cacheMethod: 'none',
    logger: () => {},
    errorHandler: () => {},
  });
  return {
    async recognize(bytes) {
      const dimensions = imageDimensions(bytes);
      const result = await worker.recognize(bytes, {}, { text: true, blocks: true });
      const text = result.data.text;
      if (text.length > 100000) throw new Error('OCR text limit');
      return {
        text,
        confidence: result.data.confidence,
        language: 'eng',
        engine: 'tesseract-7.0.0',
        ...dimensions,
        blocks: (result.data.blocks ?? [])
          .slice(0, 1000)
          .map((block) => ({ text: block.text, confidence: block.confidence, bbox: block.bbox })),
      };
    },
    terminate: () => worker.terminate(),
  };
}
