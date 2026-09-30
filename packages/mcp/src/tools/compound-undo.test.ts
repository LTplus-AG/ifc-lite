/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: real wall joining forgets old overlay profiles/axes and changes
 * positional references. Compound undo must restore that earlier IFC graph. */
import { describe, expect, it } from 'vitest';
import { IfcCreator, addWallToStore, joinWallsInStore, readWallJoinRels, readWallJoinTarget, resolveSpatialAnchor, resolveWallJoinAnchor } from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { undoPendingMutations } from './mutation-undo.js';
// Pure package-private inverse builder: inspect retained entries without
// adding a published diagnostic API or a second mutation ledger.
import { captureCompoundInverse } from '../../../mutations/dist/compound-inverse.js';
import { cooperativeOverlay } from '../../../mutations/dist/cooperative-overlay-access.js';

async function walls() {
  const creator = new IfcCreator();
  const storey = creator.addIfcBuildingStorey({ Name: 'Ground floor', Elevation: 0 });
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(creator.toIfc().content).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storey, view);
  const a = addWallToStore(editor, anchor, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3, Axis: true }).wallId;
  const b = addWallToStore(editor, anchor, { Start: [4, 0, 0], End: [4, 3, 0], Thickness: 0.2, Height: 3, Axis: true }).wallId;
  return { store, view, editor, a, b };
}

describe('#6232 D5 canonical compound undo', () => {
  it('retains a fixed-size inverse per actual wall graph as the overlay grows', async () => {
    const { store, view, editor } = await walls();
    const anchor = resolveSpatialAnchor(store, [...store.entityIndex.byType.get('IFCBUILDINGSTOREY')!][0], view);
    const sizes: number[] = [];
    for (let i = 0; i < 24; i++) {
      const before = structuredClone({ ...cooperativeOverlay(editor.getMutationView()).capture() });
      addWallToStore(editor, anchor, { Start: [0, 10 + i, 0], End: [4, 10 + i, 0], Thickness: 0.2, Height: 3, Axis: true });
      const inverse = captureCompoundInverse(before, cooperativeOverlay(view).capture());
      expect(inverse.history).toEqual([]);
      expect(inverse.maps.every(map => map.entries.every(entry => !entry.present))).toBe(true);
      sizes.push(inverse.maps.reduce((n, map) => n + map.entries.length, 0));
    }
    expect(sizes[0]).toBeGreaterThan(0);
    expect(new Set(sizes).size).toBe(1);
    expect(view.getNewEntities().filter(e => e.type === 'IfcWall')).toHaveLength(26);
  });
  it('rejects an asynchronous inverse without publishing its synchronous edits', async () => {
    const { view, editor, a } = await walls();
    editor.setAttribute(a, 'Name', 'Before undo');
    const journal = view.getMutations();
    expect(() => undoRecordedMutationOperations(view, 1, async draft => {
      draft.setAttribute(a, 'Name', 'Partial inverse', undefined, true);
      await Promise.resolve();
    })).toThrow(/dispatchers must be synchronous/);
    await Promise.resolve();
    expect(view.getMutations()).toEqual(journal);
    expect(view.getAttributeMutationsForEntity(a)).toContainEqual({ name: 'Name', value: 'Before undo' });
  });

  it('restores forgotten profiles, references and earlier history after a later raw operation', async () => {
    const { store, view, editor, a, b } = await walls();
    const before = [a, b].map(id => readWallJoinTarget(store, view, id, 1)!);
    const journal = view.getMutations();
    recordCompoundMutation(view, draft => joinWallsInStore(new StoreEditor(store, draft), store, resolveWallJoinAnchor(store, draft), a, b));
    expect(readWallJoinRels(store, view)).toHaveLength(1);
    expect(view.getNewEntity(before[0].profileId)).toBeNull();
    const raw = editor.addEntity('IfcCartesianPoint', [[7, 8, 9]]).expressId;
    undoPendingMutations(view, 1);
    expect(view.getNewEntity(raw)).toBeNull();
    undoPendingMutations(view, 1);
    expect(readWallJoinRels(store, view)).toEqual([]);
    expect(view.getMutations()).toEqual(journal);
    for (const wall of before) {
      const restored = readWallJoinTarget(store, view, wall.wallId, 1)!;
      expect(restored.profileId).toBe(wall.profileId);
      expect(restored.axisRepId).toBe(wall.axisRepId);
      expect(restored.wall).toEqual(wall.wall);
      expect(view.getNewEntity(wall.profileId)).not.toBeNull();
    }
    const bytes = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const reparsed = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    expect(reparsed.entityIndex.byType.get('IFCWALL')).toEqual(expect.arrayContaining([a, b]));
    expect(reparsed.entityIndex.byType.get('IFCRELCONNECTSPATHELEMENTS') ?? []).toEqual([]);
    expect(editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId).toBeGreaterThan(raw);
  });

  it('rolls back an entire multi-operation undo when a later inverse refuses', async () => {
    const { store, view, editor, a, b } = await walls();
    editor.setPositionalAttribute(a, 2, 'Changed name');
    recordCompoundMutation(view, draft => joinWallsInStore(new StoreEditor(store, draft), store, resolveWallJoinAnchor(store, draft), a, b));
    const journal = view.getMutations();
    expect(() => undoPendingMutations(view, 2)).toThrow(/not revertible/);
    expect(view.getMutations()).toEqual(journal);
    expect(readWallJoinRels(store, view)).toHaveLength(1);
    // A failed undo retained its compound record as well as the IFC graph.
    undoPendingMutations(view, 1);
    expect(readWallJoinRels(store, view)).toEqual([]);
  });
});
