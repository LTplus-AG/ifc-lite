/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Usage (repo root): pnpm exec tsx docs/architecture/evidence/8773-large-point-clouds/host-run.mts <e57|las|ply> <path> [maxFileSize]
import { openSync, fstatSync, readSync } from 'node:fs';
const ROOT = new URL('../../../../packages/pointcloud/src/streaming', import.meta.url).pathname;
const { streamPointCloud } = await import(`${ROOT}/host.ts`);
const { E57StreamingSource } = await import(`${ROOT}/e57-source.ts`);
const { LasStreamingSource } = await import(`${ROOT}/las-source.ts`);
const { PlyStreamingSource } = await import(`${ROOT}/ply-source.ts`);
// fs-backed Blob: Node's fs.openAsBlob wraps sizes past 2^32.
function fileBlob(p: string) {
  const fd = openSync(p, 'r'); const size = fstatSync(fd).size;
  const mk = (a: number, b: number): any => ({ size: b - a,
    slice: (s = 0, e = b - a) => mk(a + Math.max(0, s), a + Math.min(e, b - a)),
    arrayBuffer: async () => { const n = Math.max(0, b - a); const buf = Buffer.allocUnsafe(n); let o = 0; while (o < n) { const r = readSync(fd, buf, o, n - o, a + o); if (!r) break; o += r; } return buf.buffer.slice(buf.byteOffset, buf.byteOffset + o); } });
  return mk(0, size);
}
const [format, path, maxArg] = process.argv.slice(2);
const blob = fileBlob(path);
const Sources: Record<string, any> = { e57: E57StreamingSource, las: LasStreamingSource, ply: PlyStreamingSource };
let peakAB = 0; const sample = () => { const m = process.memoryUsage().arrayBuffers; if (m > peakAB) peakAB = m; };
const timer = setInterval(sample, 5);
const t0 = performance.now(); let stride = 0, chunks = 0, maxChunk = 0; let h = 0x811c9dc5;
const fnv = (a?: ArrayBufferView) => { if (!a) return; const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193) >>> 0; };
const handle = streamPointCloud({
  format, blob, label: path, maxFileSize: maxArg ? Number(maxArg) : undefined,
  createSource: (o: any) => new Sources[o.format](o.blob, { label: o.label, downsample: { stride: o.stride ?? 1 }, originOffset: o.originOffset }),
  onOpen: (info: any) => { stride = info.stride; console.log('open', JSON.stringify({ total: info.totalPointCount, stride })); },
  onChunk: (c: any) => { fnv(c.positions); fnv(c.colors); chunks++; if (c.pointCount > maxChunk) maxChunk = c.pointCount; sample(); },
  onComplete: (bbox: any, emitted: number) => console.log('DONE', JSON.stringify({ format, fileBytes: blob.size, seconds: +((performance.now() - t0) / 1000).toFixed(1), emitted, chunks, maxChunk, stride, fnv: h.toString(16), peakArrayBuffersMiB: +(peakAB / 2 ** 20).toFixed(1), bbox })),
});
try { await handle.done; } catch (e) { console.log('ERROR', (e as Error).message); }
clearInterval(timer);
