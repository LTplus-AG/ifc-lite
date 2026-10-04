/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { splitElementInStore, splitElementsInStore } from './element-split.js';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { readAttributes } from './edit/placement-core.js';
import { deriveSplitGlobalId } from './edit/split-guid.js';
import { resolveSplitTarget } from './edit/split-target.js';

async function session() {
  const bytes = new Uint8Array(await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)));
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  const id = addOrdinaryElementInStore(editor, resolveSpatialAnchor(store, 42, view), { kind: 'wall', params: { Start: [0, 5, 0], End: [8, 5, 0], Thickness: .2, Height: 3 } });
  const saved = () => new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content;
  const snapshot = () => structuredClone({ entities: [...view.getNewEntities()].sort((a, b) => a.expressId - b.expressId), mutations: view.getMutations(), changes: view.getEffectiveChanges() });
  return { store, view, editor, id, saved, snapshot };
}

describe('#6232 D5 shared split writer', () => {
  it('retains the larger source identity, shared metadata, export and complete recorded Undo in a real Bonsai source with an authored wall', async () => {
    const s = await session();
    const source = readAttributes(s.store, s.view, s.editor, s.id)!;
    const gate = resolveSplitTarget(s.store, s.view, s.editor, s.id, 1);
    expect(gate.ok).toBe(true);
    if (!gate.ok || gate.kind !== 'wall') throw new Error('Bonsai sample wall must be splittable');
    const before = s.snapshot();
    const result = recordCompoundMutation(s.view, draftView => splitElementInStore(s.store, new StoreEditor(s.store, draftView), s.id, { kind: 'wall', distance: gate.chain.wallLength / 4 }));
    expect(result.rightId).toBe(s.id);
    expect(readAttributes(s.store, s.view, s.editor, s.id)?.[0]).toBe(source[0]);
    expect(readAttributes(s.store, s.view, s.editor, result.addedId)?.[0]).not.toBe(source[0]);
    const reparsed = await new IfcParser().parseColumnar(s.saved().buffer as ArrayBuffer, { disableWorkerScan: true });
    expect(reparsed.entities.getExpressIdByGlobalId(source[0] as string)).toBe(s.id);
    expect(reparsed.entities.getTypeName(result.addedId)).toBe('IfcWall');
    undoRecordedMutationOperations(s.view, 1, () => { throw new Error('Split must record one compound'); });
    expect(s.snapshot()).toEqual(before);
  });

  it('splits authored profile members and slab footprints while preserving prior source overlays', async () => {
    const s = await session();
    s.editor.setAttribute(1222, 'Name', 'Prior wall edit');
    const anchor = resolveSpatialAnchor(s.store, 42, s.view);
    const beam = addOrdinaryElementInStore(s.editor, anchor, { kind: 'beam', params: { Start: [0, 5, 3], End: [8, 5, 3], Profile: { Type: 'Circle', Radius: .1 } } });
    const slab = addOrdinaryElementInStore(s.editor, anchor, { kind: 'slab', params: { Position: [0, 0, 0], Width: 8, Depth: 6, Thickness: .2 } });
    const result = splitElementsInStore(s.store, s.editor, [
      { expressId: beam, cut: { kind: 'linear', distance: 2 } },
      { expressId: slab, cut: { kind: 'slab', a: [2, -10], b: [2, 10] } },
    ]);
    expect(result).toHaveLength(2);
    const beamTarget = resolveSplitTarget(s.store, s.view, s.editor, beam, 1);
    expect(beamTarget.ok && beamTarget.kind === 'linear' && beamTarget.chain.depth).toBe(6);
    expect(new TextDecoder().decode(s.saved())).toContain("'Prior wall edit'");
    expect(result.every(part => s.view.getNewEntity(part.addedId))).toBe(true);
  });

  it('a late refused target rolls back the whole selected cut including GUID/allocator/journal', async () => {
    const s = await session(), control = await session();
    const gate = resolveSplitTarget(s.store, s.view, s.editor, s.id, 1);
    if (!gate.ok || gate.kind !== 'wall') throw new Error('Sample wall not readable');
    const before = s.snapshot();
    expect(() => splitElementsInStore(s.store, s.editor, [
      { expressId: s.id, cut: { kind: 'wall', distance: gate.chain.wallLength / 3 } },
      { expressId: 42, cut: { kind: 'wall', distance: 1 } },
    ])).toThrow('Split unavailable');
    expect(s.snapshot()).toEqual(before);
    expect(s.editor.addEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId)
      .toBe(control.editor.addEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId);
  });
  it('refuses a source leaf shared by another occurrence atomically (#6232)', async () => {
    const s = await session();
    const anchor = resolveSpatialAnchor(s.store, 42, s.view);
    const beam = addOrdinaryElementInStore(s.editor, anchor, { kind: 'beam', params: { Start: [0, 0, 3], End: [8, 0, 3], Width: .2, Height: .4 } });
    // Stated invariant: two distinct occurrences reference exactly the same
    // placement and Body graph, as an exporter may legitimately encode.
    const attrs = readAttributes(s.store, s.view, s.editor, beam)!;
    attrs[0] = deriveSplitGlobalId(String(attrs[0]), () => false);
    s.editor.addEntity('IfcBeam', attrs as import('@ifc-lite/mutations').IfcAttributeValue[]);
    const before = s.snapshot(), next = s.view.peekNextExpressId();
    expect(() => splitElementInStore(s.store, s.editor, beam, { kind: 'linear', distance: 2 })).toThrow('shared occurrences');
    expect(s.snapshot()).toEqual(before);
    expect(s.view.peekNextExpressId()).toBe(next);
  });

});
