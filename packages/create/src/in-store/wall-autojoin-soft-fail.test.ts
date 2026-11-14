/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, expect, it, vi } from 'vitest';
import { newStorey } from './wall-join-mesh.oracle.js';
import { addOrdinaryElementInStore, type OrdinaryInStoreElement } from './ordinary-element.js';
import { addWallToStore } from './wall.js';
import * as reads from './wall-join-read.js';
import * as schemas from './schema-attributes.js';

afterEach(() => vi.restoreAllMocks());

const horizontal = { kind: 'wall', params: {
  Start: [0, 0, 0], End: [4, 0, 0], Thickness: .2, Height: 3,
} } satisfies OrdinaryInStoreElement;
const vertical = { kind: 'wall', params: {
  Start: [4, 0, 0], End: [4, 3, 0], Thickness: .2, Height: 3,
} } satisfies OrdinaryInStoreElement;

it('#9406 unsupported join schema metadata keeps valid wall creation and returns a notice', async () => {
  const s = await newStorey();
  addWallToStore(s.editor, s.anchor, horizontal.params);
  // Keep the already-resolved creation anchor. Optional join metadata must
  // not invalidate creation just because this schema has no join registry.
  s.store.schemaVersion = 'IFC5';
  const notices: string[] = [];
  const wall = addOrdinaryElementInStore(s.editor, s.anchor, vertical, { store: s.store, notices });
  expect(s.view.getNewEntity(wall)?.type).toBe('IfcWall');
  expect(notices.join('\n')).toMatch(/skipped.*automatic wall join.*IFC5/i);
  expect(s.view.getNewEntities().filter(row => row.type === 'IfcRelConnectsPathElements')).toEqual([]);
  const before = s.view.getNewEntities();
  expect(() => addOrdinaryElementInStore(s.editor, s.anchor, { kind: 'wall', params: {
    Start: [4, 0, 0], End: [4, 0, 0], Thickness: .2, Height: 3,
  } }, { store: s.store, notices })).toThrow(/Start and End must be distinct/);
  expect(s.view.getNewEntities()).toEqual(before);
});

it('#9406 a registry failure during index setup reports skipped joins and keeps the new wall', async () => {
  const s = await newStorey();
  const old = addWallToStore(s.editor, s.anchor, horizontal.params).wallId;
  const before = reads.readWallJoinTarget(s.store, s.view, old, 1);
  const registry = schemas.schemaRegistry;
  vi.spyOn(schemas, 'schemaRegistry').mockImplementation((schema, op) => {
    if (op === 'wall-autojoin') throw new Error('join registry unavailable');
    return registry(schema, op);
  });
  const notices: string[] = [];
  const wall = addOrdinaryElementInStore(s.editor, s.anchor, vertical, { store: s.store, notices });
  expect(reads.readWallJoinTarget(s.store, s.view, wall, 1)?.wall.end).toEqual([4, 3]);
  expect(notices.join('\n')).toMatch(/skipped.*automatic wall join.*join registry unavailable/i);
  expect(reads.readWallJoinTarget(s.store, s.view, old, 1)).toEqual(before);
  expect(reads.readWallJoinRels(s.store, s.view)).toEqual([]);
});

it('#9406 an endpoint index read failure is returned as a notice instead of just logged', async () => {
  const s = await newStorey();
  addWallToStore(s.editor, s.anchor, horizontal.params);
  vi.spyOn(reads, 'readWallJoinEndpoints').mockImplementationOnce(() => { throw new Error('index endpoint unreadable'); });
  const notices: string[] = [];
  const wall = addOrdinaryElementInStore(s.editor, s.anchor, vertical, { store: s.store, notices });
  expect(s.view.getNewEntity(wall)?.type).toBe('IfcWall');
  expect(notices.join('\n')).toMatch(/skipped.*automatic wall join.*index endpoint unreadable/i);
  expect(reads.readWallJoinRels(s.store, s.view)).toEqual([]);
});

it('#9406 an initial join read failure keeps the wall and invalidates its incomplete endpoint cache', async () => {
  const s = await newStorey();
  addOrdinaryElementInStore(s.editor, s.anchor, horizontal, { store: s.store });
  vi.spyOn(reads, 'readWallJoinTarget').mockImplementationOnce(() => { throw new Error('join target unreadable'); });
  const notices: string[] = [];
  const a = addOrdinaryElementInStore(s.editor, s.anchor, vertical, { store: s.store, notices });
  expect(s.view.getNewEntity(a)?.type).toBe('IfcWall');
  expect(notices.join('\n')).toMatch(/skipped.*automatic wall join.*join target unreadable/i);
  const b = addOrdinaryElementInStore(s.editor, s.anchor, { kind: 'wall', params: {
    Start: [4, 3, 0], End: [8, 3, 0], Thickness: .2, Height: 3,
  } }, { store: s.store });
  expect(reads.readWallJoinRels(s.store, s.view)).toMatchObject([{ relatingId: a, relatedId: b }]);
});
