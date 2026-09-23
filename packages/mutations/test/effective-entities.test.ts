/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Contract for the shared effective-entity enumeration (#5249, charter #5236),
 * driven through the real write path: `StoreEditor` over a real
 * `MutablePropertyView`, exactly as a live viewer/CLI/MCP session edits. The
 * algorithm lives in `@ifc-lite/data` (`iterateEffectiveEntities`, so IDS and
 * charts can use it without depending on this package). This package's
 * `iterateEffectiveEntityIds` delegates to it, and this is the package that
 * produces the overlays it has to read.
 */

import { describe, expect, it } from 'vitest';
import { iterateEffectiveEntities, type EffectiveEntitySource } from '@ifc-lite/data';
import {
  MutablePropertyView,
  StoreEditor,
  iterateEffectiveEntityIds,
  type MutationEntityRef,
  type MutationStoreShape,
} from '../src/index.js';

type Source = EffectiveEntitySource & MutationStoreShape & { entityIndex: { byType: Map<string, number[]> } };

const ids = (rows: Iterable<{ expressId: number }>) => Array.from(rows, ({ expressId }) => expressId);
const effectiveEntityIds = (store: Source, view: MutablePropertyView | null) => ids(iterateEffectiveEntityIds(store, view));
const effectiveEntityIdsOfType = (store: Source, view: MutablePropertyView | null, types: string | string[]) =>
  ids(iterateEffectiveEntityIds(store, view, typeof types === 'string' ? [types] : types));

/** A parsed-store stand-in: `byId` and `byType` agree, as the parser builds them. */
function makeStore(entities: Array<[number, string]>): Source {
  const byId = new Map<number, MutationEntityRef>();
  const byType = new Map<string, number[]>();
  for (const [id, type] of entities) {
    byId.set(id, { expressId: id, type, byteOffset: 0, byteLength: 1, lineNumber: id });
    const bucket = byType.get(type) ?? [];
    bucket.push(id);
    byType.set(type, bucket);
  }
  return { entityIndex: { byId, byType } };
}

function session(entities: Array<[number, string]>, modelId = 'm1') {
  const store = makeStore(entities);
  const view = new MutablePropertyView(null, modelId);
  const editor = new StoreEditor(store, view);
  return { store, view, editor };
}

const BASE: Array<[number, string]> = [
  [1, 'IFCWALL'],
  [2, 'IFCWALL'],
  [3, 'IFCDOOR'],
  [4, 'IFCSLAB'],
];

describe('effective entity accessor (#5249)', () => {
  it('base: with no overlay, or an untouched one, answers exactly the source index', () => {
    const { store, view } = session(BASE);
    expect(effectiveEntityIds(store, null)).toEqual([1, 2, 3, 4]);
    expect(effectiveEntityIds(store, view)).toEqual([1, 2, 3, 4]);
    expect(effectiveEntityIdsOfType(store, view, 'IfcWall')).toEqual([1, 2]);
    expect(effectiveEntityIdsOfType(store, view, ['IFCDOOR', 'IFCSLAB'])).toEqual([3, 4]);
    expect(effectiveEntityIdsOfType(store, view, 'IfcColumn')).toEqual([]);
  });

  it('deleted: a tombstoned source entity is absent from both enumerations', () => {
    const { store, view, editor } = session(BASE);
    expect(editor.removeEntity(2)).toBe(true);

    expect(effectiveEntityIds(store, view)).toEqual([1, 3, 4]);
    expect(effectiveEntityIdsOfType(store, view, 'IfcWall')).toEqual([1]);
    // The parsed index is untouched — the overlay is the only record.
    expect(store.entityIndex.byType.get('IFCWALL')).toEqual([1, 2]);
  });

  it('created: an overlay-created entity is listed once, under its class, after the source ids', () => {
    const { store, view, editor } = session(BASE);
    const wall = editor.addEntity('IfcWall', []).expressId;
    const column = editor.addEntity('IfcColumn', []).expressId;

    expect(effectiveEntityIds(store, view)).toEqual([1, 2, 3, 4, wall, column]);
    expect(effectiveEntityIdsOfType(store, view, 'IFCWALL')).toEqual([1, 2, wall]);
    expect(effectiveEntityIdsOfType(store, view, 'ifccolumn')).toEqual([column]);
    // Asking for the same class twice does not list anything twice.
    expect(effectiveEntityIdsOfType(store, view, ['IfcWall', 'IFCWALL'])).toEqual([1, 2, wall]);
  });

  it('created-then-deleted: absent everywhere, and does not also remove a source entity', () => {
    const { store, view, editor } = session(BASE);
    const kept = editor.addEntity('IfcWall', []).expressId;
    const gone = editor.addEntity('IfcWall', []).expressId;
    expect(editor.removeEntity(gone)).toBe(true);
    expect(view.isDeleted(gone)).toBe(true);

    expect(effectiveEntityIds(store, view)).toEqual([1, 2, 3, 4, kept]);
    expect(effectiveEntityIdsOfType(store, view, 'IfcWall')).toEqual([1, 2, kept]);
  });

  it('deleted and created together: both directions are answered in one pass', () => {
    const { store, view, editor } = session(BASE);
    editor.removeEntity(1);
    const created = editor.addEntity('IfcWall', []).expressId;

    const walls = effectiveEntityIdsOfType(store, view, 'IfcWall');
    expect(walls).toEqual([2, created]);
    expect(walls).not.toContain(1);
    expect(effectiveEntityIds(store, view)).toEqual([2, 3, 4, created]);
  });

  it('retype: an entity is listed under its new class only, source or created', () => {
    const { store, view, editor } = session(BASE);
    expect(editor.setEntityType(2, 'IfcColumn')).toBe(true);
    const created = editor.addEntity('IfcWall', []).expressId;
    expect(editor.setEntityType(created, 'IfcBeam')).toBe(true);

    expect(effectiveEntityIdsOfType(store, view, 'IfcWall')).toEqual([1]);
    expect(effectiveEntityIdsOfType(store, view, 'IfcColumn')).toEqual([2]);
    expect(effectiveEntityIdsOfType(store, view, 'IfcBeam')).toEqual([created]);
    // Asking for both classes still lists the retyped entity exactly once.
    expect(effectiveEntityIdsOfType(store, view, ['IfcWall', 'IfcColumn'])).toEqual([1, 2]);
    // A retyped-then-deleted entity is gone from its new class too.
    editor.removeEntity(2);
    expect(effectiveEntityIdsOfType(store, view, 'IfcColumn')).toEqual([]);
  });

  it('reads the overlay at call time, so undo of a delete brings the entity back', () => {
    const { store, view, editor } = session(BASE);
    editor.removeEntity(3);
    expect(effectiveEntityIdsOfType(store, view, 'IfcDoor')).toEqual([]);
    expect(view.restoreFromTombstone(3)).toBe(true);
    expect(effectiveEntityIdsOfType(store, view, 'IfcDoor')).toEqual([3]);
  });

  it('two-model isolation: each model answers only from its own overlay', () => {
    // Federated models commonly overlap in local express ids.
    const a = session(BASE, 'model-a');
    const b = session(BASE, 'model-b');
    a.editor.removeEntity(1);
    const createdInA = a.editor.addEntity('IfcWall', []).expressId;
    b.editor.removeEntity(3);

    expect(effectiveEntityIdsOfType(a.store, a.view, 'IfcWall')).toEqual([2, createdInA]);
    expect(effectiveEntityIdsOfType(a.store, a.view, 'IfcDoor')).toEqual([3]);
    expect(effectiveEntityIdsOfType(b.store, b.view, 'IfcWall')).toEqual([1, 2]);
    expect(effectiveEntityIdsOfType(b.store, b.view, 'IfcDoor')).toEqual([]);
    expect(effectiveEntityIds(b.store, b.view)).toEqual([1, 2, 4]);
    // Pairing a store with the other model's overlay is the caller's explicit
    // choice, never an implicit global lookup: it answers from that overlay.
    expect(effectiveEntityIds(b.store, a.view)).toEqual([2, 3, 4, createdInA]);
  });

  it('the shared core accepts a structured-clone snapshot of the overlay, not only a live view', () => {
    const { store, view, editor } = session(BASE);
    editor.removeEntity(4);
    const created = editor.addEntity('IfcSlab', []).expressId;
    // What a worker receives: plain arrays rebuilt into the structural shape.
    const snapshot = JSON.parse(JSON.stringify({
      tombstones: Array.from(view.getTombstones()),
      created: view.getNewEntities().map(({ expressId, type }) => ({ expressId, type })),
    })) as { tombstones: number[]; created: Array<{ expressId: number; type: string }> };
    const tombstones = new Set(snapshot.tombstones);
    const overlay = { isDeleted: (id: number) => tombstones.has(id), getNewEntities: () => snapshot.created };

    expect(ids(iterateEffectiveEntities(store, overlay, ['IfcSlab']))).toEqual([created]);
    expect(ids(iterateEffectiveEntities(store, overlay))).toEqual(effectiveEntityIds(store, view));
  });

  it('never mutates the source index', () => {
    const { store, view, editor } = session(BASE);
    editor.removeEntity(1);
    editor.addEntity('IfcWall', []);
    editor.setEntityType(2, 'IfcColumn');
    effectiveEntityIdsOfType(store, view, ['IfcWall', 'IfcColumn']);
    expect(store.entityIndex.byType.get('IFCWALL')).toEqual([1, 2]);
  });
});
