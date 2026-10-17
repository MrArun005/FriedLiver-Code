// Scales PNGs for the gallery off the extension host's thread (see workerScaler in imageAccess.ts).
import { parentPort } from 'node:worker_threads';
import { downscalePng } from './png';

parentPort?.on('message', (m: { id: number; png: Uint8Array; max: number }) => {
  let out: Buffer | null;
  try {
    out = downscalePng(Buffer.from(m.png.buffer, m.png.byteOffset, m.png.byteLength), m.max);
  } catch {
    out = null;
  }
  parentPort!.postMessage({ id: m.id, out });
});
