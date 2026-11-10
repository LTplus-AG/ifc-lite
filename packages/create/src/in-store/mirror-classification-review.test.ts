// SPDX-License-Identifier: MPL-2.0
import { expect, it } from 'vitest';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { newStorey, exportText, parse } from './wall-join-mesh.oracle.js';
import { addClassificationInStore } from './classification.js';
import { mirrorElementsInStore } from './element-mirror.js';
import { addGridToStore, rectangularGridAxes } from './grid.js';
import { addWallToStore } from './wall.js';
import { addHostedDoorToStore } from './hosted-fill.js';
import { resolveHostAnchor } from './resolve-host.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';
import { schemaAttributes, schemaRegistry } from './schema-attributes.js';

for (const schema of ['IFC4', 'IFC4X3'] as const) it(`#9409 classification reuse matches an omitted edition exactly (${schema})`, async () => {
  const s = await newStorey(schema);
  const add = (Edition?: string) => addClassificationInStore(s.store, s.editor, { System: 'Uniclass', Identification: 'EF_25', Edition });
  const versioned = add('2024'), unversioned = add();
  expect(unversioned).not.toBe(versioned);
  expect(add()).toBe(unversioned);
  expect(add('2024')).toBe(versioned);
  expect(add('2025')).not.toBe(versioned);
  const saved = await parse(exportText(s)), reader = new AnchorEntityReader(saved, null);
  const source = (id: number) => refId(reader.entity(id)!.attributes[reader.entity(id)!.names.indexOf('ReferencedSource')]);
  const a = reader.entity(source(versioned)!)!, b = reader.entity(source(unversioned)!)!;
  expect(a.attributes[a.names.indexOf('Edition')]).toBe('2024');
  expect(b.attributes[b.names.indexOf('Edition')] ?? null).toBeNull();
  expect([...reader.ids('IFCCLASSIFICATION')]).toHaveLength(3);
});

for (const copy of [false, true]) it(`#9409 refuses grid mirroring atomically (copy=${copy})`, async () => {
  const s = await newStorey();
  const grid = addGridToStore(s.editor, s.anchor, { Position: [3, 0, 0],
    ...rectangularGridAxes({ UOffsets: [2, 5], VOffsets: [0, 4] }),
  });
  const before = exportText(s), next = s.view.peekNextExpressId(), journal = s.view.getMutations();
  expect(() => mirrorElementsInStore(s.store, s.editor, [grid.gridId], { axis: [[0, 0], [0, 10]], copy })).toThrow(/mirror.*grids/i);
  expect(exportText(s)).toBe(before);
  expect(s.view.getMutations()).toEqual(journal);
  expect(s.view.peekNextExpressId()).toBe(next);
});

for (const schema of ['IFC2X3', 'IFC4'] as const) it(`#9409 mirrors door ${schema === 'IFC2X3' ? 'styles' : 'types'} without changing unselected users (${schema})`, async () => {
  const s = await newStorey(schema);
  const wall = (y: number) => addWallToStore(s.editor, s.anchor, { Start: [2, y, 0], End: [8, y, 0], Thickness: .2, Height: 3 });
  const a = wall(1), b = wall(5);
  const door = (host: number, Offset: number) => addHostedDoorToStore(s.editor, resolveHostAnchor(s.store, host, s.view), {
    Offset, Width: .9, Height: 2.1, OperationType: 'SINGLE_SWING_LEFT',
  }).fillingId;
  const selected = [door(a.wallId, 1), door(a.wallId, 3)], untouched = door(b.wallId, 1);
  const registry = schemaRegistry(schema, 'test');
  const emit = (type: string, values: Record<string, unknown>) => s.editor.addEntity(type,
    schemaAttributes(registry, type, values, 'test') as Parameters<typeof s.editor.addEntity>[1]).expressId;
  const type = schema === 'IFC2X3' ? 'IfcDoorStyle' : 'IfcDoorType';
  const original = emit(type, { GlobalId: generateIfcGuid(), OwnerHistory: s.anchor.ownerHistoryId === null ? null : `#${s.anchor.ownerHistoryId}`, Name: 'Shared left door',
    OperationType: 'SINGLE_SWING_LEFT', ParameterTakesPrecedence: false,
    ...(schema === 'IFC2X3' ? { ConstructionType: 'NOTDEFINED', Sizeable: true } : { PredefinedType: 'DOOR' }),
  });
  emit('IfcRelDefinesByType', { GlobalId: generateIfcGuid(), OwnerHistory: s.anchor.ownerHistoryId === null ? null : `#${s.anchor.ownerHistoryId}`,
    RelatedObjects: [...selected, untouched].map(id => `#${id}`), RelatingType: `#${original}` });
  mirrorElementsInStore(s.store, s.editor, [a.wallId], { axis: [[0, 0], [0, 10]] });
  const saved = await parse(exportText(s)), view = new MutablePropertyView(saved.properties, 'saved');
  const reader = new AnchorEntityReader(saved, view);
  const typeFor = (id: number) => [...reader.ids('IFCRELDEFINESBYTYPE')].map(rel => reader.entity(rel)!)
    .filter(rel => Array.isArray(rel.attributes[4]) && rel.attributes[4].some(value => refId(value) === id))
    .map(rel => refId(rel.attributes[5]));
  const mirrored = typeFor(selected[0]);
  expect(mirrored).toHaveLength(1);
  expect(mirrored[0]).not.toBe(original);
  expect(typeFor(selected[1])).toEqual(mirrored);
  expect(typeFor(untouched)).toEqual([original]);
  for (const [id, operation] of [[mirrored[0]!, '.SINGLE_SWING_RIGHT.'], [original, '.SINGLE_SWING_LEFT.']] as const) {
    const entity = reader.entity(id)!;
    expect(entity.attributes[entity.names.indexOf('OperationType')]).toBe(operation);
  }
  expect([...reader.ids(type.toUpperCase())]).toHaveLength(2);
});
