/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: draft preparation and the shared builder must preserve prior
 * parsed-source edits, helpers, journal and allocation across commit/refusal. */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { EntityExtractor, IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { addOrdinaryElementInStore, type OrdinaryInStoreElement } from './ordinary-element.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';

const SAMPLE = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
const STOREY = 42;
const WALL = { kind: 'wall' as const, params: {
  Start: [0, 5, 0] as [number, number, number], End: [4, 5, 0] as [number, number, number], Thickness: 0.2, Height: 3,
} };
const ELEMENTS: OrdinaryInStoreElement[] = [
  WALL,
  { kind: 'column', params: { Position: [1, 2, 0], Width: .3, Depth: .4, Height: 3 } },
  { kind: 'slab', params: { Position: [1, 2, 0], Width: 4, Depth: 3, Thickness: .2 } },
  { kind: 'beam', params: { Start: [0, 0, 3], End: [4, 0, 3], Width: .2, Height: .4 } },
  { kind: 'space', params: { Position: [1, 2, 0], Width: 4, Depth: 3, Height: 3 } },
  { kind: 'roof', params: { Position: [1, 2, 3], Width: 4, Depth: 3, Thickness: .2 } },
  { kind: 'plate', params: { Position: [1, 2, 0], Width: 4, Depth: 3, Thickness: .02 } },
  { kind: 'member', params: { Start: [0, 0, 3], End: [4, 0, 3], Width: .2, Height: .4 } },
];

async function session(withOwnerHistory = false) {
  const source = await readFile(SAMPLE, 'utf8');
  // A valid optional owner-history control, inserted into the actual parsed
  // Bonsai file. Neither schema nor metadata is overridden after parsing.
  const records = [
    '#3000=IFCOWNERHISTORY(#3001,#3002,$,.ADDED.,$,$,$,0);',
    '#3001=IFCPERSONANDORGANIZATION(#3003,#3004,$);',
    "#3002=IFCAPPLICATION(#3004,'1.0','D5 Controls','D5');",
    "#3003=IFCPERSON($,'D5','Test',$,$,$,$,$);",
    "#3004=IFCORGANIZATION($,'D5',$,$,$);",
  ].join('\n');
  const bytes = new TextEncoder().encode(withOwnerHistory
    ? source.replace(/ENDSEC;\s*END-ISO-10303-21;\s*$/, `${records}\nENDSEC;\nEND-ISO-10303-21;`)
    : source);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true },
  );
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  // Both a positional overlay on a helper and a named edit to a source root
  // existed before creation. Export/reparse below proves they survive.
  const prior = editor.addEntity('IfcCartesianPoint', [[7, 8, 9]]).expressId;
  editor.setPositionalAttribute(prior, 0, [7, 8, 10]);
  editor.setAttribute(1222, 'Name', 'Prior source wall');
  const removed = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  editor.removeEntity(removed);
  const snapshot = () => structuredClone({
    entities: view.getNewEntities(), journal: view.getMutations(),
    positional: view.getPositionalMutationsForEntity(prior),
    named: view.getAttributeMutationsForEntity(1222), deleted: view.isDeleted(removed),
    properties: view.getForEntity(1222),
  });
  const saved = () => new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  return { store, view, editor, prior, removed, snapshot, saved };
}

describe('#6232 D5 ordinary atomic commit', () => {
  for (const element of ELEMENTS) {
    it(`${element.kind} exports a readable product/body and refuses a malformed GUID without helpers`, async () => {
      const s = await session(), before = s.snapshot(), next = s.view.peekNextExpressId();
      const anchor = resolveSpatialAnchor(s.store, STOREY, s.view);
      const invalid = structuredClone(element);
      invalid.params.GlobalId = 'invalid';
      expect(() => addOrdinaryElementInStore(s.editor, anchor, invalid)).toThrow(/not a valid 22-character IFC GUID/);
      expect(s.snapshot()).toEqual(before);
      expect(s.view.peekNextExpressId()).toBe(next);
      const id = addOrdinaryElementInStore(s.editor, anchor, element);
      const bytes = s.saved();
      const parsed = await new IfcParser().parseColumnar(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true },
      );
      const extractor = new EntityExtractor(parsed.source);
      const product = extractor.extractEntity(parsed.entityIndex.byId.get(id)!);
      expect(product?.type).toBe(`IFC${element.kind.toUpperCase()}`);
      const representation = product?.attributes[6];
      expect(typeof representation).toBe('number');
      expect(extractor.extractEntity(parsed.entityIndex.byId.get(representation as number)!)?.type).toBe('IFCPRODUCTDEFINITIONSHAPE');
      expect(parsed.entityIndex.byId.has(s.prior)).toBe(true);
    });
  }

  it('publishes draft placement preparation with its wall and retains earlier source/overlay edits', async () => {
    const s = await session(true);
    const owner = resolveSpatialAnchor(s.store, STOREY, s.view).ownerHistoryId;
    expect(owner).toBe(3000);
    const before = s.snapshot();
    expect(before.properties.length).toBeGreaterThan(0);
    let placement = 0;
    const wall = addOrdinaryElementInStore(s.editor, draft => {
      const point = draft.addEntity('IfcCartesianPoint', [[10, 20, 2]]).expressId;
      const axis = draft.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
      placement = draft.addEntity('IfcLocalPlacement', [null, `#${axis}`]).expressId;
      draft.setPositionalAttribute(STOREY, 5, `#${placement}`);
      const anchor = resolveSpatialAnchor(s.store, STOREY, draft.getMutationView());
      expect(anchor.storeyPlacementId).toBe(placement);
      expect(anchor.ownerHistoryId).toBe(owner);
      expect(draft.getMutationView().getForEntity(1222), 'draft retains the real source property extractor').toEqual(before.properties);
      expect(s.snapshot(), 'preparation has not published through the transaction callback').toEqual(before);
      return anchor;
    }, WALL);
    const bytes = s.saved();
    const parsed = await new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true },
    );
    const extractor = new EntityExtractor(parsed.source);
    const entity = (id: number) => extractor.extractEntity(parsed.entityIndex.byId.get(id)!);
    expect(entity(s.prior)?.attributes[0]).toEqual([7, 8, 10]);
    expect(entity(1222)?.attributes[2]).toBe('Prior source wall');
    expect(parsed.entityIndex.byId.has(s.removed)).toBe(false);
    expect(entity(STOREY)?.attributes[5]).toBe(placement);
    const wallAttributes = entity(wall)!.attributes;
    expect(wallAttributes[1]).toBe(owner);
    expect(entity(wallAttributes[5] as number)?.attributes[0]).toBe(placement);
    expect(parsed.spatialHierarchy?.elementToStorey.get(wall)).toBe(STOREY);
    expect(s.view.getMutations().slice(0, before.journal.length)).toEqual(before.journal);
    expect(s.view.peekNextExpressId()).toBeGreaterThan(wall);
  });

  it('late invalid GlobalId rolls back preparation and builder allocation together', async () => {
    const s = await session(), before = s.snapshot(), next = s.view.peekNextExpressId();
    expect(() => addOrdinaryElementInStore(s.editor, draft => {
      const point = draft.addEntity('IfcCartesianPoint', [[10, 20, 2]]).expressId;
      const axis = draft.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
      const placement = draft.addEntity('IfcLocalPlacement', [null, `#${axis}`]).expressId;
      draft.setPositionalAttribute(STOREY, 5, `#${placement}`);
      return resolveSpatialAnchor(s.store, STOREY, draft.getMutationView());
    }, { ...WALL, params: { ...WALL.params, GlobalId: 'invalid' } })).toThrow(/not a valid 22-character IFC GUID/);
    expect(s.snapshot()).toEqual(before);
    expect(s.view.peekNextExpressId()).toBe(next);
    // No stale skipped ID or preparation entity remains reachable after failure.
    expect(s.editor.addEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId).toBe(next);
  });

  it('compound recording around the dispatcher undoes only this graph and keeps IDs monotonic', async () => {
    const s = await session(), before = s.snapshot();
    const wall = recordCompoundMutation(s.view, draftView => {
      const draft = new StoreEditor(s.store, draftView);
      return addOrdinaryElementInStore(draft, resolveSpatialAnchor(s.store, STOREY, draftView), WALL);
    });
    const high = s.view.peekNextExpressId();
    expect(s.view.getNewEntity(wall)?.type).toBe('IfcWall');
    const reverted = undoRecordedMutationOperations(s.view, 1, () => {
      throw new Error('ordinary creation must be one recorded compound, not a raw inverse');
    });
    expect(reverted).toBeGreaterThan(1);
    expect(s.snapshot()).toEqual(before);
    expect(s.view.peekNextExpressId()).toBe(high);
    expect(s.editor.addEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId).toBe(high);
  });
});
