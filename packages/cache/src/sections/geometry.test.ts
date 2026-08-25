/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-mesh record round-trip, at the level `writeMeshRecord` /
 * `readMeshRecord` actually operate on.
 *
 * geometry-chunks.test.ts covers the same writer through the v13 chunk
 * section, but it compares meshes with a helper that only looks at
 * expressId/ifcType/geometryClass/color/origin/arrays — a field the writer
 * drops is invisible to it. These tests read the record back field by field,
 * and check the byte accounting the chunk budgeter depends on.
 */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { writeMeshRecord, readMeshRecord, meshRecordByteLength } from './geometry.js';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import { FORMAT_VERSION } from '../types.js';

function mesh(overrides: Partial<MeshData> = {}): MeshData {
  return {
    expressId: 8970,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.5, 0.25, 0.125, 1],
    // 7 bytes keeps every following field 4-byte aligned, which
    // `readFloat32Array` needs (it views the buffer rather than copying).
    ifcType: 'IFCWALL',
    geometryClass: 0,
    origin: [10, 20, 30],
    ...overrides,
  };
}

/** Write one record and read it straight back. */
function roundTrip(m: MeshData, version: number = FORMAT_VERSION): MeshData {
  const writer = new BufferWriter();
  writeMeshRecord(writer, m);
  return readMeshRecord(new BufferReader(writer.build()), version, 0);
}

describe('mesh record source ids (#3199)', () => {
  it('carries geometryItemId back, and leaves materialId absent', () => {
    // 4638 is a real IfcRepresentationItem id from tests/models/ara3d/duplex.ifc.
    const out = roundTrip(mesh({ geometryItemId: 4638 }));
    expect(out.geometryItemId).toBe(4638);
    expect(out.materialId).toBeUndefined();
  });

  it('carries materialId back, and leaves geometryItemId absent', () => {
    // 3941 is a real IfcMaterial id from the same fixture's layered walls.
    const out = roundTrip(mesh({ geometryClass: 3, materialId: 3941 }));
    expect(out.materialId).toBe(3941);
    expect(out.geometryItemId).toBeUndefined();
    expect(out.geometryClass).toBe(3);
  });

  it('leaves both absent when the mesh carried neither', () => {
    const out = roundTrip(mesh());
    expect(out.geometryItemId).toBeUndefined();
    expect(out.materialId).toBeUndefined();
  });

  it('never invents the other id: a restored mesh carries at most one', () => {
    for (const m of [
      mesh({ geometryItemId: 4638 }),
      mesh({ geometryClass: 3, materialId: 3941 }),
      mesh(),
    ]) {
      const out = roundTrip(m);
      expect(out.geometryItemId === undefined || out.materialId === undefined).toBe(true);
    }
  });

  it('round-trips a 0 materialId rather than reading it as "absent"', () => {
    // This pins the ENCODING, not a claim about what the producer emits.
    //
    // History, because the stated reason changed mid-PR and a stale one here
    // would mislead: `IfcMaterialLayer.Material` is OPTIONAL,
    // `material_layer_index.rs` decoded an absent one as `material_id = 0`
    // ("Zero means no material"), and a duplex.ifc with #3876's material
    // dropped produced 12 meshes carrying `materialId: 0` at the wasm boundary.
    // #3199 then filtered 0 to `None` at the producer, since `#0` is not a STEP
    // instance name — so that measurement no longer describes the runtime, and
    // the air-gap behaviour is pinned where it belongs, in
    // `scripts/test-wasm-contract.mjs` and `mesh_id_provenance.rs`.
    //
    // What survives is the encoding rule: 0 is falsy, and a format that spells
    // "absent" as 0 cannot distinguish the two. That must hold whatever the
    // producer decides to send, which is why this test still passes a 0.
    const out = roundTrip(mesh({ geometryClass: 3, materialId: 0 }));
    expect(out.materialId).toBe(0);
    expect(out.geometryItemId).toBeUndefined();
  });
});

describe('mesh record byte accounting', () => {
  // geometry-chunks.ts budgets chunk sizes with meshRecordByteLength and then
  // rejects a chunk whose records do not consume it exactly, so a wrong count
  // is a hard read failure later, not a rounding error.
  it('meshRecordByteLength matches the bytes written, for every id combination', () => {
    for (const m of [
      mesh(),
      mesh({ geometryItemId: 4638 }),
      mesh({ materialId: 3941 }),
      mesh({ materialId: 0 }),
      mesh({ ifcType: undefined }),
    ]) {
      const writer = new BufferWriter();
      writeMeshRecord(writer, m);
      expect(writer.position).toBe(meshRecordByteLength(m));
    }
  });

  it('the record is longer than a v13 one, which is what the version bump was for', () => {
    // Not pinned to an exact delta: how the ids are encoded is still open (two
    // bare u32 cannot represent a 0 materialId — see the air-gap test).
    // What must hold is that the record grew at all, because that is what makes
    // a v13 reader misparse a v14 record and what FORMAT_VERSION has to signal.
    const m = mesh({ geometryItemId: 4638 });
    const v13Length =
      4 + 4 + 4 + 16 + 4 + 7 + 1 + 24 +
      m.positions.byteLength + m.normals.byteLength + m.indices.byteLength;
    expect(meshRecordByteLength(m)).toBeGreaterThanOrEqual(v13Length + 8);
  });
});

describe('mesh record version gating', () => {
  /** The v13 record layout: identical, minus the two id words. */
  function writeV13Record(writer: BufferWriter, m: MeshData): void {
    writer.writeUint32(m.expressId);
    writer.writeUint32(m.positions.length / 3);
    writer.writeUint32(m.indices.length);
    for (const c of m.color) writer.writeFloat32(c);
    writer.writeString(m.ifcType || '');
    writer.writeUint8(m.geometryClass ?? 0);
    writer.writeFloat64(m.origin ? m.origin[0] : 0);
    writer.writeFloat64(m.origin ? m.origin[1] : 0);
    writer.writeFloat64(m.origin ? m.origin[2] : 0);
    writer.writeTypedArray(m.positions);
    writer.writeTypedArray(m.normals);
    writer.writeTypedArray(m.indices);
  }

  it('reads a v13 record at version 13: no ids, and every later field intact', () => {
    // The version gate has to be aligned as well as present. If it read the
    // ids unconditionally it would take them out of the origin, and the
    // failure would surface as displaced geometry rather than a missing id.
    const source = mesh({ expressId: 4242, origin: [10, 20, 30] });
    const writer = new BufferWriter();
    writeV13Record(writer, source);
    const out = readMeshRecord(new BufferReader(writer.build()), 13, 0);

    expect(out.geometryItemId).toBeUndefined();
    expect(out.materialId).toBeUndefined();
    expect(out.expressId).toBe(4242);
    expect(out.ifcType).toBe('IFCWALL');
    expect(out.origin).toEqual([10, 20, 30]);
    expect(Array.from(out.positions)).toEqual(Array.from(source.positions));
    expect(Array.from(out.indices)).toEqual(Array.from(source.indices));
  });

  it('an old cache degrades the ids to unknown, never to a wrong id', () => {
    // A v13 entry has no id bytes at all, so "absent" is the only honest
    // answer — and it is the same state the runtime uses where the identity
    // was genuinely merged away. Nothing downstream has to special-case it.
    const writer = new BufferWriter();
    writeV13Record(writer, mesh({ geometryClass: 3 }));
    const out = readMeshRecord(new BufferReader(writer.build()), 13, 0);
    expect('geometryItemId' in out).toBe(false);
    expect('materialId' in out).toBe(false);
  });
});
