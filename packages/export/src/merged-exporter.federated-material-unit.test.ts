/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Round-trip invariant: a merged (federated) STEP file's material-layer
 * thickness reads back in the SAME value as reading each source model
 * independently, GlobalId-matched — `parse(merge(A,B))` must agree with
 * `parse(A) ∪ parse(B)`.
 *
 * `MergedExporter`'s default `unitReconciliation: 'auto'` FEDERATES a model
 * whose length unit differs from the first model's: it keeps its own
 * `IfcProject`/`IfcUnitAssignment` rather than being rescaled (see that
 * module's docs, "the mis-scale bug, issue #1332"), so the merged STEP text
 * for the second model's `IfcMaterialLayer.LayerThickness` is the correct,
 * untouched raw literal in ITS OWN unit.
 *
 * The reader side had a matching bug: `extractMaterialsOnDemand` scaled every
 * layer's raw thickness by `store.lengthUnitScale`, computed once per store by
 * `extractLengthUnitScale` from the FIRST `IfcProject` found — correct for an
 * ordinary single-project file, but wrong for a federated entity belonging to
 * a LATER project. A 300&nbsp;mm layer in a millimetre-federated model read
 * back as a fabricated 300&nbsp;m one (raw 300 × the first project's
 * metre-scale 1.0).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { IfcParser, extractMaterialsOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MergedExporter } from './merged-exporter.js';

const MODELS_DIR = resolve(__dirname, '../../../tests/models');

// Model A: inches (IfcConversionBasedUnit 'inch', 0.0254 m — #28/#27/#26),
// IfcSlab layer thickness raw literal 6. (see #310/#292 in the source
// fixture). Model B: millimetres, IfcWall layer thickness raw literal 300.
// (see #63/#45). Two DIFFERENT non-metre units on purpose, so a bug that
// merely swapped which of two units gets used could not pass by accident.
// Both small, real-world fixtures fetched via `pnpm fixtures` (AGENTS.md);
// skip cleanly when absent.
const FILE_A = 'issues/856_wall_decode_failed.ifc';
const FILE_B = 'buildingsmart/wall-with-opening-and-window.ifc';
const GUID_A_SLAB = '20WrgxqpbDtferON_k1P2X'; // IfcSlab, model A (metres)
const GUID_B_WALL = '3ZYW59sxj8lei475l7EhLU'; // IfcWall, model B (millimetres)

const FIXTURES_AVAILABLE = [FILE_A, FILE_B].every((f) => existsSync(resolve(MODELS_DIR, f)));

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function parseFixture(name: string): Promise<IfcDataStore> {
  const parser = new IfcParser();
  return parser.parseColumnar(toArrayBuffer(readFileSync(resolve(MODELS_DIR, name))));
}

/** Find an entity's express id by its GlobalId, decoding straight from source
 *  (mirrors how `MergedExporter` itself reads a rooted entity's leading
 *  attribute — no dependency on any cache the fix under test might affect). */
function findIdByGuid(store: IfcDataStore, guid: string): number {
  for (const [id, ref] of store.entityIndex.byId) {
    const text = store.source!.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength);
    if (text.includes(`'${guid}'`)) return id;
  }
  throw new Error(`GlobalId ${guid} not found`);
}

describe.skipIf(!FIXTURES_AVAILABLE)('MergedExporter federated material-layer unit scale', () => {
  it('keeps a federated (different-unit) model\'s material-layer thickness correct after merge + re-parse', async () => {
    const storeA = await parseFixture(FILE_A);
    const storeB = await parseFixture(FILE_B);

    // Sanity: the two fixtures really do declare different length units —
    // this is the precondition for MergedExporter to federate rather than
    // fold model B into a single unified project.
    expect(storeA.lengthUnitScale).toBeCloseTo(0.0254, 9); // inches
    expect(storeB.lengthUnitScale).toBe(0.001); // millimetres

    // Control: each model read independently — the values this test's merged
    // read must agree with, GlobalId-matched.
    const slabIdA = findIdByGuid(storeA, GUID_A_SLAB);
    const wallIdB = findIdByGuid(storeB, GUID_B_WALL);
    const expectedSlabThicknessM = extractMaterialsOnDemand(storeA, slabIdA)?.layers?.[0]?.thickness;
    const expectedWallThicknessM = extractMaterialsOnDemand(storeB, wallIdB)?.layers?.[0]?.thickness;
    expect(expectedSlabThicknessM).toBeCloseTo(6 * 0.0254, 9);
    expect(expectedWallThicknessM).toBeCloseTo(0.3, 9);

    const exporter = new MergedExporter([
      { id: 'A', name: 'ModelA', dataStore: storeA },
      { id: 'B', name: 'ModelB', dataStore: storeB },
    ]);
    // Default unitReconciliation: 'auto' — model B federates (kept in its own
    // IfcProject/IfcUnitAssignment) since its unit differs from model A's.
    const result = exporter.export({ schema: 'IFC4' });
    expect(result.stats.federatedModelCount).toBeGreaterThan(0);

    const merged = await parseColumnarFromBytes(result.content);

    const slabIdMerged = findIdByGuid(merged, GUID_A_SLAB);
    const wallIdMerged = findIdByGuid(merged, GUID_B_WALL);

    // Control: model A's own entity is unaffected (first-project fast path —
    // already correct before this fix, must stay correct after).
    const slabThicknessMerged = extractMaterialsOnDemand(merged, slabIdMerged)?.layers?.[0]?.thickness;
    expect(slabThicknessMerged).toBeCloseTo(expectedSlabThicknessM!, 9);

    // The invariant under test: model B's federated (millimetre) entity must
    // read back at the SAME value as reading model B alone (0.3 m), not the
    // fabricated 300 a first-project-only unit scale corrupts it to.
    const wallThicknessMerged = extractMaterialsOnDemand(merged, wallIdMerged)?.layers?.[0]?.thickness;
    expect(wallThicknessMerged).toBeCloseTo(expectedWallThicknessM!, 9);
  });
});

async function parseColumnarFromBytes(content: Uint8Array): Promise<IfcDataStore> {
  const parser = new IfcParser();
  const ab = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
  return parser.parseColumnar(ab);
}
