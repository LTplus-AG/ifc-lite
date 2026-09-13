/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4381 — the real CRAS pair's transferred output (docs/architecture/evidence/
 * scan-registration-cras/) reopens through ifc-lite's own reader with the wall
 * geometry unchanged and the atlas bound to it, survives IFCZIP packaging, and
 * reaches a fresh room guest with the same texture bytes and UVs.
 *
 * The transferred IFC was produced by the canonical WASM point transfer over the
 * registered CRAS subset and applied independently (IfcOpenShell, see the
 * evidence README); this test is the ifc-lite side of that reopen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzlibSync, zipSync } from 'fflate';
import * as collab from '@ifc-lite/collab';
import { ColumnarParser, StepTokenizer, unwrapIfcZipWithResources, type IfcDataStore } from '@ifc-lite/parser';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import type { CollabSeedModel } from '../../collab/owner-seed.js';
import { roomSlotRef } from '../../collab/model-slot-ref.js';
import { joiner, localIdOf, ownerShare } from '../../../test/collab-room-harness.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');
const EVIDENCE = join(REPO_ROOT, 'docs', 'architecture', 'evidence', 'scan-registration-cras');
const WASM = join(REPO_ROOT, 'packages', 'wasm', 'pkg', 'ifc-lite_bg.wasm');
const WALL_GUID = '1gsZ4XbYD0qRhfvwOUEK3Z'; // Basic Wall:(10cm) Drywall:969917, the corridor's east wall
const TARGET = 'craslabbim-ifc4-tessellated.ifc';
const TRANSFERRED = 'craslabbim-ifc4-tessellated-transferred-wall-1117.ifc';

async function parseStore(bytes: Uint8Array): Promise<IfcDataStore> {
  const refs = Array.from(new StepTokenizer(bytes).scanEntitiesFast(), ref => ({ expressId: ref.expressId, type: ref.type, byteOffset: ref.offset, byteLength: ref.length, lineNumber: ref.line }));
  return new ColumnarParser().parseLite(bytes.buffer as ArrayBuffer, refs, {});
}
async function tessellate(bytes: Uint8Array): Promise<MeshData[]> {
  const processor = new GeometryProcessor();
  try { await processor.init(); return (await processor.process(bytes.slice())).meshes; } finally { processor.dispose(); }
}
/** Minimal PNG decode (8-bit RGB/RGBA, non-interlaced, filters 0-4) so the test needs no browser image decoder. */
function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8, width = 0, height = 0, channels = 4; const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset), type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = view.getUint32(offset + 8); height = view.getUint32(offset + 12); assert.equal(png[offset + 16], 8, '8-bit'); channels = png[offset + 17] === 6 ? 4 : 3; assert.equal(png[offset + 20], 0, 'not interlaced'); }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const raw = unzlibSync(idat.length === 1 ? idat[0] : Uint8Array.from(idat.flatMap(d => [...d])));
  const stride = width * channels, rgba = new Uint8Array(width * height * 4), previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), line = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0, b = previous[i], c = i >= channels ? previous[i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a; else if (filter === 2) predictor = b; else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (row[i] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) { rgba.set(line.subarray(x * channels, x * channels + 3), (y * width + x) * 4); rgba[(y * width + x) * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255; }
    previous.set(line);
  }
  return { width, height, rgba };
}

describe('CRAS transferred output reopens, packages and shares (#4381)', () => {
  it('ifc-lite reopens the transferred wall with unchanged geometry and the atlas bound; IFCZIP and a fresh room guest keep the texture', async t => {
    if (!existsSync(WASM)) { t.skip('build WASM with pnpm build:wasm'); return; }
    const targetBytes = new Uint8Array(readFileSync(join(EVIDENCE, TARGET)));
    const transferredBytes = new Uint8Array(readFileSync(join(EVIDENCE, TRANSFERRED)));
    const summary = JSON.parse(readFileSync(join(EVIDENCE, 'transfer-summary-wall-1117.json'), 'utf8')) as { runs: { label: string; assets: { imageUri: string }[]; coverage: { observedRasterInteriorTexels: number } }[] };
    const accepted = summary.runs.find(run => run.label === 'tolerance' && run.assets?.length)!;
    const imageUri = accepted.assets[0].imageUri;
    const png = new Uint8Array(readFileSync(join(EVIDENCE, imageUri)));
    assert.equal(imageUri, `textures/${createHash('sha256').update(png).digest('hex')}.png`, 'the atlas file is named by its own SHA-256');

    // 1. ifc-lite's own reader: geometry unchanged, UVs and the image reference present.
    const [targetStore, store] = await Promise.all([parseStore(targetBytes.slice()), parseStore(transferredBytes.slice())]);
    const wallId = (s: IfcDataStore) => { for (let id = 1; id < 100_000; id++) if (s.entities.getGlobalId(id) === WALL_GUID) return id; throw new Error('wall missing'); };
    const [before, after] = await Promise.all([tessellate(targetBytes), tessellate(transferredBytes)]);
    const wallBefore = before.find(m => m.expressId === wallId(targetStore))!, wallAfter = after.find(m => m.expressId === wallId(store))!;
    assert.ok(wallBefore && wallAfter, 'the drywall tessellates before and after');
    assert.equal(wallAfter.indices.length, wallBefore.indices.length, 'triangle count unchanged');
    for (let i = 0; i < wallBefore.indices.length; i++) for (let axis = 0; axis < 3; axis++) {
      assert.equal(wallAfter.positions[wallAfter.indices[i] * 3 + axis], wallBefore.positions[wallBefore.indices[i] * 3 + axis], 'ordered corners unchanged');
    }
    assert.ok(wallAfter.uvs && wallAfter.uvs.length === (wallAfter.positions.length / 3) * 2, 'one UV per vertex');
    assert.equal(wallAfter.textureRef?.url, imageUri, 'the mesh references the atlas by its relative URI');
    assert.equal(after.filter(m => m.textureRef).length, 1, 'only the transferred wall is textured');
    assert.ok(accepted.coverage.observedRasterInteriorTexels > 0);

    // 2. IFCZIP packaging: the archive convention the viewer exports and reopens.
    const zipped = zipSync({ [TRANSFERRED]: transferredBytes, [imageUri]: png });
    const contents = await unwrapIfcZipWithResources(zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer);
    assert.deepEqual(new Uint8Array(contents.model), transferredBytes, 'the model entry is the transferred IFC, byte-exact');
    assert.deepEqual(contents.originalResources.get(imageUri), png, 'the atlas travels next to the IFC under the referenced path');
    assert.equal(contents.resourcesIncomplete, false);

    // 3. Fresh share join: the owner seeds the transferred model, a guest reconstructs it with the texture bytes.
    const decoded = decodePng(png);
    const seeded: MeshData[] = after.map(m => m.expressId === wallAfter.expressId
      ? { ...m, texture: { width: decoded.width, height: decoded.height, rgba: decoded.rgba, repeatS: false, repeatT: false } }
      : m);
    const models: CollabSeedModel[] = [{ modelId: 'cras', name: TRANSFERRED, store, isIfcx: false, meshes: seeded, idOffset: 0, schemaVersion: 'IFC4', fileName: TRANSFERRED }];
    const doc = collab.createCollabDoc(), blobStore = new collab.MemoryBlobStore();
    const { outcome } = await ownerShare(doc, blobStore, models, new Map([['cras', roomSlotRef(0)]]));
    assert.deepEqual(outcome, { phase: 'ready', failure: null });
    const guest = joiner(doc, blobStore, 'cras');
    await guest.reconstructor.reconstruct();
    const model = guest.store.get().models.get('room:cras:m0')!;
    assert.ok(model?.geometryResult, 'the guest holds the room model');
    const guestWall = model.geometryResult!.meshes.find(m => m.expressId === model.idOffset + localIdOf(model, `/m0/${WALL_GUID}`));
    assert.ok(guestWall, 'the transferred wall is selectable by its GlobalId path on the guest');
    assert.deepEqual(guestWall.texture?.rgba, decoded.rgba, 'the atlas pixels arrive byte-exact');
    assert.deepEqual(guestWall.uvs, wallAfter.uvs, 'the UVs bind the same texels');
    t.diagnostic(`CRAS wall ${WALL_GUID}: ${wallAfter.indices.length / 3} triangles, atlas ${decoded.width}x${decoded.height}, observed texels ${accepted.coverage.observedRasterInteriorTexels}`);
  });
});
