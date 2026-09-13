/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model slots (#4444): one room, several models, distinct even when the
 * models are byte-identical. Pins the property the issue reproduces — two
 * copies of one file share every GlobalId — against the real seeders and
 * the real snapshot writer.
 */

import { describe, expect, it } from 'vitest';
import { createCollabDoc, entitiesMap, metaMap } from '../src/doc/schema.js';
import { addGeometryRef, entityToJSON, getEntity, getGeometryRef } from '../src/doc/entity.js';
import { createGeometry } from '../src/doc/geometry.js';
import {
  createModelSlot,
  getModelSlot,
  legacyModelSlot,
  listModelSlots,
  modelSlotId,
  modelSlotRef,
  pathInSlot,
  prefixPathForSlot,
  slotIdOfPath,
  slotPath,
  type ModelSlotRef,
} from '../src/doc/model-slot.js';
import { guidToPath, seedFromStep, type StepSeedSource } from '../src/snapshot/from-step.js';
import { seedFromIfcx } from '../src/snapshot/from-ifcx.js';
import { snapshotToIfcx } from '../src/snapshot/to-ifcx.js';

const WALL = '0aBcDeFgHiJkLmNoPqRsT1';

function childrenOf(doc: ReturnType<typeof createCollabDoc>, path: string): Record<string, string> {
  const entity = getEntity(doc, path);
  if (!entity) throw new Error(`missing entity ${path}`);
  return entityToJSON(entity).children;
}
const STOREY = '0aBcDeFgHiJkLmNoPqRsT2';

/** The same file twice: identical GlobalIds, identical containment. */
function stepSource(slot: ModelSlotRef = legacyModelSlot()): StepSeedSource {
  return {
    header: { schema: 'IFC4', fileName: 'AC20-FZK-Haus.ifc' },
    entities: [
      {
        guid: STOREY,
        ifcClass: 'IfcBuildingStorey',
        children: { [slotPath(slot, WALL)]: slotPath(slot, WALL) },
      },
      { guid: WALL, ifcClass: 'IfcWallStandardCase', attributes: { 'bsi::ifc::prop::Name': 'Wall A' } },
    ],
  };
}

describe('slot paths', () => {
  it('mints slot ids from seed order, never from the model', () => {
    expect(modelSlotId(0)).toBe('m0');
    expect(modelSlotId(7)).toBe('m7');
    expect(() => modelSlotId(-1)).toThrow();
    expect(() => modelSlotRef('AC20-FZK-Haus.ifc')).toThrow();
  });

  it('qualifies GlobalId and IFCX paths under the slot, and the legacy slot leaves them alone', () => {
    const m1 = modelSlotRef('m1');
    expect(slotPath(m1, WALL)).toBe(`/m1/${WALL}`);
    expect(slotPath(legacyModelSlot(), WALL)).toBe(guidToPath(WALL));
    expect(prefixPathForSlot(m1, 'abc/def')).toBe('/m1/abc/def');
    expect(prefixPathForSlot(m1, '/abc')).toBe('/m1/abc');
    expect(prefixPathForSlot(legacyModelSlot(), '/abc')).toBe('/abc');
  });

  it('tells slots apart by prefix, and reads every path as the legacy slot', () => {
    const m0 = modelSlotRef('m0');
    const m1 = modelSlotRef('m1');
    const p = slotPath(m1, WALL);
    expect(pathInSlot(m1, p)).toBe(true);
    expect(pathInSlot(m0, p)).toBe(false);
    // `m1` is not a prefix of `m10`.
    expect(pathInSlot(m1, slotPath(modelSlotRef('m10'), WALL))).toBe(false);
    expect(pathInSlot(legacyModelSlot(), p)).toBe(true);
    expect(pathInSlot(legacyModelSlot(), guidToPath(WALL))).toBe(true);
    expect(slotIdOfPath(p)).toBe('m1');
    expect(slotIdOfPath(guidToPath(WALL))).toBe(null);
  });
});

describe('model slot records', () => {
  it('records slots in seed order and is idempotent on the slot id', () => {
    const doc = createCollabDoc();
    createModelSlot(doc, 'm1', { name: 'second', order: 1 });
    const first = createModelSlot(doc, 'm0', { name: 'first', order: 0, fileName: 'a.ifc', schemaVersion: 'IFC4', stepSourceBlobHash: 'a'.repeat(32), stepSourceFormat: 'ifczip' });
    // A second create for the same slot does not overwrite the record.
    createModelSlot(doc, 'm0', { name: 'renamed', order: 5 });
    expect(first.pathPrefix).toBe('/m0');
    expect(first.stepSourceBlobHash).toBe('a'.repeat(32));
    expect(first.stepSourceFormat).toBe('ifczip');
    expect(getModelSlot(doc, 'm0')?.stepSourceFormat).toBe('ifczip');
    expect(getModelSlot(doc, 'm0')?.name).toBe('first');
    expect(listModelSlots(doc).map((s) => [s.slotId, s.name, s.legacy])).toEqual([
      ['m0', 'first', false],
      ['m1', 'second', false],
    ]);
  });

  it('reads a room seeded before slots existed as one legacy slot named after its file', () => {
    const doc = createCollabDoc();
    seedFromStep(doc, stepSource());
    const slots = listModelSlots(doc);
    expect(slots).toHaveLength(1);
    expect(slots[0].legacy).toBe(true);
    expect(slots[0].pathPrefix).toBe('');
    expect(slots[0].name).toBe('AC20-FZK-Haus.ifc');
    // And the legacy slot's snapshot is the whole room, at the old paths.
    const paths = snapshotToIfcx(doc, { slot: slots[0] }).data.map((n) => n.path).sort();
    expect(paths).toEqual([guidToPath(WALL), guidToPath(STOREY)].sort());
  });

  it('drops an untrusted portable-source reference unless it is a canonical content hash', () => {
    const doc = createCollabDoc();
    doc.getMap('models').set('m0', {
      name: 'bad source', order: 0, stepSourceBlobHash: 'A'.repeat(32),
    });
    expect(getModelSlot(doc, 'm0')?.stepSourceBlobHash).toBeUndefined();
    doc.getMap('models').set('m0', {
      name: 'bad source', order: 0, stepSourceBlobHash: '../blob',
    });
    expect(getModelSlot(doc, 'm0')?.stepSourceBlobHash).toBeUndefined();
  });
});

describe('two copies of one file (#4444)', () => {
  it('STEP: seed into two slots, and the second copy is not merged into the first', () => {
    const doc = createCollabDoc();
    const m0 = modelSlotRef('m0');
    const m1 = modelSlotRef('m1');
    createModelSlot(doc, 'm0', { name: 'copy A', order: 0 });
    createModelSlot(doc, 'm1', { name: 'copy B', order: 1 });
    const a = seedFromStep(doc, stepSource(m0), { slot: m0 });
    const b = seedFromStep(doc, stepSource(m1), { slot: m1 });
    expect(a.seeded).toBe(2);
    expect(b.seeded).toBe(2);
    expect(entitiesMap(doc).size).toBe(4);

    // Distinct geometry per copy: a mesh attached to copy A's wall is not on
    // copy B's wall, even though both walls carry the same GlobalId.
    createGeometry(doc, 'hashA', { type: 'mesh', source: 'mesh-blob', blobHash: 'hashA' });
    createGeometry(doc, 'hashB', { type: 'mesh', source: 'mesh-blob', blobHash: 'hashB' });
    addGeometryRef(doc, slotPath(m0, WALL), 'hashA');
    addGeometryRef(doc, slotPath(m1, WALL), 'hashB');
    expect(getGeometryRef(doc, slotPath(m0, WALL))).toEqual({ geomIds: ['hashA'] });
    expect(getGeometryRef(doc, slotPath(m1, WALL))).toEqual({ geomIds: ['hashB'] });

    // Containment stays inside the slot.
    expect(Object.values(childrenOf(doc, slotPath(m1, STOREY)))).toEqual([slotPath(m1, WALL)]);

    // Per-slot snapshots partition the room; the old whole-room snapshot still
    // sees everything.
    const snapA = snapshotToIfcx(doc, { slot: m0 }).data.map((n) => n.path).sort();
    const snapB = snapshotToIfcx(doc, { slot: m1 }).data.map((n) => n.path).sort();
    expect(snapA).toEqual([slotPath(m0, STOREY), slotPath(m0, WALL)].sort());
    expect(snapB).toEqual([slotPath(m1, STOREY), slotPath(m1, WALL)].sort());
    expect(snapshotToIfcx(doc).data).toHaveLength(4);

    // The file header is recorded once, for the room, not overwritten per slot.
    expect((metaMap(doc).get('stepHeader') as { fileName: string }).fileName).toBe('AC20-FZK-Haus.ifc');
  });

  it('IFCX: seed the same file into two slots; children and inherits follow the slot', () => {
    const file = JSON.stringify({
      header: { id: 'x', ifcxVersion: 'ifcx_alpha', dataVersion: '1', author: 'a', timestamp: 't' },
      imports: [],
      schemas: {},
      data: [
        { path: 'site', attributes: { 'bsi::ifc::class': { code: 'IfcSite' } }, children: { wall: 'wall' } },
        { path: 'wall', attributes: { 'bsi::ifc::class': { code: 'IfcWall' } }, inherits: { type: '/wallType' } },
        { path: '/wallType', attributes: { 'bsi::ifc::class': { code: 'IfcWallType' } } },
      ],
    });
    const doc = createCollabDoc();
    const m0 = modelSlotRef('m0');
    const m1 = modelSlotRef('m1');
    seedFromIfcx(doc, file, { slot: m0 });
    seedFromIfcx(doc, file, { slot: m1 });
    expect(entitiesMap(doc).size).toBe(6);
    expect(getEntity(doc, '/m1/wall')).toBeDefined();
    expect(getEntity(doc, '/m1/wallType')).toBeDefined();
    expect(childrenOf(doc, '/m0/site')).toEqual({ wall: '/m0/wall' });
    expect(childrenOf(doc, '/m1/site')).toEqual({ wall: '/m1/wall' });
    const wallJson = snapshotToIfcx(doc, { slot: m1 }).data.find((n) => n.path === '/m1/wall');
    expect(wallJson?.inherits).toEqual({ type: '/m1/wallType' });
    // Re-seeding a per-slot snapshot into a fresh doc reproduces that slot only.
    const fresh = createCollabDoc();
    seedFromIfcx(fresh, JSON.stringify(snapshotToIfcx(doc, { slot: m1 })));
    expect(Array.from(entitiesMap(fresh).keys()).sort()).toEqual(['/m1/site', '/m1/wall', '/m1/wallType']);
  });

  it('IFCX: each slot keeps its own header / imports / schemas; a per-slot snapshot emits only those', () => {
    const fileFor = (tag: string) =>
      JSON.stringify({
        header: { id: `file-${tag}`, ifcxVersion: 'ifcx_alpha', dataVersion: '1', author: tag, timestamp: 't' },
        imports: [{ uri: `https://example.test/${tag}.ifcx` }],
        schemas: { [`${tag}::schema`]: { value: { dataType: 'String' } } },
        data: [{ path: 'site', attributes: { 'bsi::ifc::class': { code: 'IfcSite' } } }],
      });
    const doc = createCollabDoc();
    const m0 = modelSlotRef('m0');
    const m1 = modelSlotRef('m1');
    seedFromIfcx(doc, fileFor('a'), { slot: m0 });
    seedFromIfcx(doc, fileFor('b'), { slot: m1 });

    // The second seed did not overwrite the first's file metadata.
    const snapA = snapshotToIfcx(doc, { slot: m0 });
    const snapB = snapshotToIfcx(doc, { slot: m1 });
    expect(snapA.header.id).toBe('file-a');
    expect(snapB.header.id).toBe('file-b');
    expect(Object.keys(snapA.schemas)).toEqual(['a::schema']);
    expect(Object.keys(snapB.schemas)).toEqual(['b::schema']);
    expect(snapA.imports).toEqual([{ uri: 'https://example.test/a.ifcx' }]);
    expect(snapB.imports).toEqual([{ uri: 'https://example.test/b.ifcx' }]);
    // Per-slot seeds never touch the room-wide keys a legacy room reads.
    expect(metaMap(doc).get('schemas')).toBeUndefined();

    // A whole-room snapshot merges every slot's file metadata, in slot order.
    const whole = snapshotToIfcx(doc);
    expect(Object.keys(whole.schemas).sort()).toEqual(['a::schema', 'b::schema']);
    expect(whole.imports).toEqual([
      { uri: 'https://example.test/a.ifcx' },
      { uri: 'https://example.test/b.ifcx' },
    ]);
    expect(whole.header.id).toBe('file-a');

    // A slot-less (legacy) seed still writes and reads the room-wide keys.
    const legacy = createCollabDoc();
    seedFromIfcx(legacy, fileFor('c'));
    expect(Object.keys(snapshotToIfcx(legacy).schemas)).toEqual(['c::schema']);
    expect(Object.keys(snapshotToIfcx(legacy, { slot: legacyModelSlot() }).schemas)).toEqual(['c::schema']);
  });
});
