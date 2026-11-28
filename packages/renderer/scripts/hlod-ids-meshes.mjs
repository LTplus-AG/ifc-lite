/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Spike helper for hlod-ids-size.ts: MODEL.ifc -> OUT.bin of flat meshes (plain node, built geometry package).
import { readFileSync, writeFileSync } from 'node:fs';
import { GeometryProcessor } from '../../geometry/dist/index.js';
const [file, out] = process.argv.slice(2);
const p = new GeometryProcessor({ enableInstancing: false });
await p.init();
const { meshes } = await p.process(new Uint8Array(readFileSync(file)));
const parts = []; const head = [];
for (const m of meshes) {
  if (!m.positions || m.positions.length < 9) continue;
  head.push({ expressId: m.expressId, color: [...m.color], material: m.material ?? null, origin: m.origin ? [...m.origin] : null,
    nPos: m.positions.length, nIdx: m.indices.length, ids: !!m.entityIds });
  parts.push(Buffer.from(new Float32Array(m.positions).buffer), Buffer.from(new Uint32Array(m.indices).buffer));
  if (m.entityIds) parts.push(Buffer.from(new Uint32Array(m.entityIds).buffer));
}
const h = Buffer.from(JSON.stringify(head)); const len = Buffer.alloc(4); len.writeUInt32LE(h.length);
writeFileSync(out, Buffer.concat([len, h, ...parts]));
console.log(`meshes ${head.length}`);
process.exit(0);
