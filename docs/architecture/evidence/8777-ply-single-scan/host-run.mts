/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Usage (repo root): pnpm exec tsx docs/architecture/evidence/8777-ply-single-scan/host-run.mts <pointcloud src dir> <file.ply>
// Streams a PLY through streamPointCloud with the real in-process source and
// the viewer's options (autoOrigin, default 25M cap), counting every byte read.
import { openSync, fstatSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
const [srcDir, path] = process.argv.slice(2);
const ROOT = resolve(srcDir, 'streaming');
const { streamPointCloud } = await import(`${ROOT}/host.ts`);
const { PlyStreamingSource } = await import(`${ROOT}/ply-source.ts`);
let bytesRead = 0, reads = 0;
// fs-backed Blob: Node's fs.openAsBlob wraps sizes past 2^32.
function fileBlob(p: string) {
  const fd = openSync(p, 'r'); const size = fstatSync(fd).size;
  const mk = (a: number, b: number): any => ({ size: b - a,
    slice: (s = 0, e = b - a) => mk(a + Math.max(0, s), a + Math.min(e, b - a)),
    arrayBuffer: async () => { const n = Math.max(0, b - a); const buf = Buffer.allocUnsafe(n); let o = 0; while (o < n) { const r = readSync(fd, buf, o, n - o, a + o); if (!r) break; o += r; } bytesRead += o; reads++; return buf.buffer.slice(buf.byteOffset, buf.byteOffset + o); } });
  return mk(0, size);
}
const blob = fileBlob(path);
const t0 = performance.now(); let h = 0x811c9dc5, openAt = 0;
const fnv = (a?: ArrayBufferView) => { if (!a) return; const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193) >>> 0; };
const handle = streamPointCloud({
  format: 'ply', blob, label: path, autoOrigin: true,
  createSource: (o: any) => new PlyStreamingSource(o.blob, { label: o.label, downsample: { stride: o.stride ?? 1 }, originOffset: o.originOffset }),
  onOpen: () => { openAt = performance.now() - t0; },
  onChunk: (c: any) => { fnv(c.positions); fnv(c.colors); },
  onComplete: (bbox: any, emitted: number) => console.log(JSON.stringify({
    fileBytes: blob.size, bytesRead, readsOverFile: +(bytesRead / blob.size).toFixed(3), reads,
    openSeconds: +(openAt / 1000).toFixed(1), totalSeconds: +((performance.now() - t0) / 1000).toFixed(1),
    emitted, fnv: h.toString(16), bbox,
  })),
});
await handle.done;
