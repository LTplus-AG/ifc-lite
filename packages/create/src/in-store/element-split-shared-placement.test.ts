/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { asExpressIdRef, readAttributes, resolvePlacementChain } from './edit/placement-core.js';
import { splitElementInStore } from './element-split.js';
import { resolveSplitTarget } from './edit/split-target.js';
import { meshStairs as meshProducts, stairMeshBounds, stairWasmAvailable } from './__test__/stair-mesh.oracle.js';

const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
const cases = (['wall', 'beam'] as const).flatMap(kind => [false, true].map(persisted => ({ kind, persisted })));
it.skipIf(!stairWasmAvailable).each(cases)('#6232 $kind shared placement only refuses relocated source, persisted=$persisted (pnpm build:wasm)', async ({ kind, persisted }) => {
  const bytes = await readFile(sample);
  let store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  let view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 42, view);
  const add = (length: number) => addOrdinaryElementInStore(editor, anchor, kind === 'wall'
    ? { kind: 'wall', params: { Start: [10, 10, 1], End: [10 + length, 10, 1], Thickness: .2, Height: 3, Axis: false } }
    : { kind: 'beam', params: { Start: [10, 10, 1], End: [10 + length, 10, 1], Width: .2, Height: .4 } });
  const source = add(8), peer = add(2);
  const sourcePlacement = resolvePlacementChain(store, view, editor, source)!;
  editor.setPositionalAttribute(peer, 5, `#${sourcePlacement.localPlacementId}`);
  const text = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content);
  if (persisted) {
    store = await new IfcParser().parseColumnar(new TextEncoder().encode(text()).buffer, { disableWorkerScan: true });
    view = new MutablePropertyView(null, 'm'); editor = new StoreEditor(store, view);
  }
  const chain = resolvePlacementChain(store, view, editor, source)!;
  const location = readAttributes(store, view, editor, chain.cartesianPointId);
  const placement = readAttributes(store, view, editor, chain.localPlacementId);
  const guid = readAttributes(store, view, editor, source)![0];
  const snapshot = () => structuredClone({ text: text(), records: view.getNewEntities(), journal: view.getMutations() });
  const original = snapshot(), next = view.peekNextExpressId();
  const before = await meshProducts(text());
  expect(before.get(source)?.length).toBeGreaterThan(0);
  expect(before.get(peer)?.length).toBeGreaterThan(0);
  const cutKind = kind === 'wall' ? 'wall' : 'linear';
  // The shorter first piece would move the source's shared placement; refusal
  // must preserve every graph record and the allocator, not just the peer mesh.
  expect(() => splitElementInStore(store, editor, source, { kind: cutKind, distance: 2 })).toThrow('shared occurrences');
  expect(snapshot()).toEqual(original);
  expect(view.peekNextExpressId()).toBe(next);
  const result = recordCompoundMutation(view, draft => splitElementInStore(store, new StoreEditor(store, draft), source, { kind: cutKind, distance: 6 }));
  expect(result.leftId).toBe(source);
  expect(result.rightId).toBe(result.addedId);
  expect(readAttributes(store, view, editor, source)?.[0]).toBe(guid);
  expect(readAttributes(store, view, editor, chain.cartesianPointId)).toEqual(location);
  expect(readAttributes(store, view, editor, chain.localPlacementId)).toEqual(placement);
  expect(asExpressIdRef(readAttributes(store, view, editor, peer)?.[5])).toBe(chain.localPlacementId);
  const target = resolveSplitTarget(store, view, editor, source, 1);
  expect(target.ok && (target.kind === 'wall' ? target.chain.wallLength : target.kind === 'linear' ? target.chain.depth : null)).toBe(6);
  const after = await meshProducts(text());
  expect(after.get(result.addedId)?.length).toBeGreaterThan(0);
  expect(after.get(peer)).toEqual(before.get(peer));
  const actual = stairMeshBounds([...after.get(source)!, ...after.get(result.addedId)!]);
  const expected = stairMeshBounds(before.get(source)!);
  for (const edge of ['min', 'max'] as const) for (let i = 0; i < 3; i++) expect(actual[edge][i]).toBeCloseTo(expected[edge][i], 5);
  undoRecordedMutationOperations(view, 1, () => { throw new Error('Split must record one compound'); });
  expect(snapshot()).toEqual(original);
  expect((await meshProducts(text())).get(source)).toEqual(before.get(source));
});
