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
import * as inStore from './index.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';

const { replaceElementInStore } = inStore;
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

async function session(withOwnerHistory = false, wallType: 'IfcWall' | 'IfcWallStandardCase' = 'IfcWall') {
  const source = (await readFile(SAMPLE, 'utf8'))
    .replace('#1222=IFCWALL(', `#1222=${wallType.toUpperCase()}(`);
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
  // #6710: compare all bytes without an elapsed wall-clock header changing them.
  const saved = () => new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-02T00:00:00' }).content;
  return { store, view, editor, prior, removed, snapshot, saved };
}

describe('#6232 D5 ordinary atomic commit', () => {
  for (const wallType of ['IfcWall', 'IfcWallStandardCase'] as const) {
    it(`#6710 still replaces a parsed ${wallType} source without weakening schema subtype admission`, async () => {
      const s = await session(false, wallType);
      // This admission control uses a host without live void relationships;
      // the unmodified Bonsai host is the refusal control below.
      s.editor.removeEntity(1328);
      s.editor.removeEntity(1457);
      const before = s.snapshot();
      expect(new EntityExtractor(s.store.source).extractEntity(s.store.entityIndex.byId.get(1222)!)?.type)
        .toBe(wallType.toUpperCase());
      // #6710: missing public capability must fail an assertion before the
      // real-model operation, rather than becoming an inverse load failure.
      expect(typeof replaceElementInStore).toBe('function');
      const replacement = replaceElementInStore(s.store, s.editor, 1222,
        draft => resolveSpatialAnchor(s.store, STOREY, draft.getMutationView()), WALL);
      expect(replacement.removedIds).toEqual([1222]);
      const bytes = s.saved();
      const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
      expect(parsed.entityIndex.byId.has(1222)).toBe(false);
      expect(parsed.entityIndex.byId.has(s.prior)).toBe(true);
      const extractor = new EntityExtractor(parsed.source);
      const wall = extractor.extractEntity(parsed.entityIndex.byId.get(replacement.expressId)!);
      expect(wall?.type).toBe('IFCWALL');
      expect(extractor.extractEntity(parsed.entityIndex.byId.get(wall!.attributes[6] as number)!)?.type)
        .toBe('IFCPRODUCTDEFINITIONSHAPE');
      expect(parsed.spatialHierarchy?.elementToStorey.get(replacement.expressId)).toBe(STOREY);
      expect(s.view.getMutations().slice(0, before.journal.length)).toEqual(before.journal);
    });
  }

  for (const wallType of ['IfcWall', 'IfcWallStandardCase'] as const) {
    it(`#6710 refuses a parsed ${wallType} with live openings before preparation, preserving fillings and exported bytes`, async () => {
      const s = await session(false, wallType), before = s.snapshot(), bytes = s.saved(), next = s.view.peekNextExpressId();
      let prepared = false;
      expect(() => replaceElementInStore(s.store, s.editor, 1222, draft => {
        prepared = true;
        draft.addEntity('IfcCartesianPoint', [[99, 99, 99]]);
        return resolveSpatialAnchor(s.store, STOREY, draft.getMutationView());
      }, WALL)).toThrow(/unsupported hosted-opening source/);
      expect(prepared).toBe(false);
      expect(s.snapshot()).toEqual(before);
      expect(s.view.peekNextExpressId()).toBe(next);
      expect(s.saved()).toEqual(bytes);
      for (const id of [1222, 1299, 1262, 1443, 1407, 1328, 1334, 1457, 1463]) expect(s.view.isDeleted(id)).toBe(false);
    });
  }

  it('#6710 refuses a stair flight hosting an opening before replacement preparation or direct removal', async () => {
    const s = await session(), anchor = resolveSpatialAnchor(s.store, STOREY, s.view);
    const stair = inStore.addStairToStore(s.editor, anchor, {
      Position: [0, 5, 0], NumberOfRisers: 10, RiserHeight: .2, TreadLength: .3, Width: 1,
    });
    // Attach an actual parsed Bonsai opening and its live void relationship
    // to the authored flight; its filling remains independently live.
    s.editor.setPositionalAttribute(1328, 4, `#${stair.flightId}`);
    const before = s.snapshot(), bytes = s.saved(), next = s.view.peekNextExpressId();
    let prepared = false;
    expect(() => replaceElementInStore(s.store, s.editor, stair.stairId, draft => {
      prepared = true;
      return resolveSpatialAnchor(s.store, STOREY, draft.getMutationView());
    }, WALL)).toThrow(/hosts a live opening/);
    expect(prepared).toBe(false);
    expect(() => inStore.removeStairInStore(s.store, s.editor, stair.stairId)).toThrow(/hosts a live opening/);
    expect(s.snapshot()).toEqual(before);
    expect(s.view.peekNextExpressId()).toBe(next);
    expect(s.saved()).toEqual(bytes);
    for (const id of [stair.stairId, stair.flightId, 1299, 1262, 1328, 1334]) expect(s.view.isDeleted(id)).toBe(false);
  });

  for (const sourceKind of ['curtain assembly', 'bound grid', 'spatial storey', 'ordinary aggregate root'] as const) {
    it(`#6710 refuses unsupported ${sourceKind} replacement before preparation or graph changes`, async () => {
      const s = await session(), anchor = resolveSpatialAnchor(s.store, STOREY, s.view);
      let oldId: number;
      let relatedIds: number[] = [];
      if (sourceKind === 'curtain assembly') {
        const built = inStore.addCurtainWallToStore(s.editor, anchor, {
          Start: [0, 0, 0], End: [4, 0, 0], Height: 3, UGrid: 2, VGrid: 1,
        });
        oldId = built.curtainWallId;
        relatedIds = [...built.mullionIds, ...built.transomIds, ...built.panelIds];
        expect(relatedIds.length).toBeGreaterThan(0);
      } else if (sourceKind === 'bound grid') {
        const built = inStore.addGridToStore(s.editor, anchor, {
          UAxes: [{ Tag: 'U', Start: [0, -1], End: [0, 1] }],
          VAxes: [{ Tag: 'V', Start: [-1, 0], End: [1, 0] }],
        });
        const bound = inStore.addColumnOnGridToStore(s.editor, s.store, anchor,
          { Position: [0, 0, 0], Width: .2, Depth: .2, Height: 3 },
          { GridId: built.gridId, IntersectingAxes: [built.uAxisIds[0], built.vAxisIds[0]] });
        oldId = built.gridId;
        relatedIds = [bound.columnId, bound.gridPlacement.placementId,
          bound.gridPlacement.intersectionId, ...built.uAxisIds, ...built.vAxisIds];
      } else if (sourceKind === 'ordinary aggregate root') {
        oldId = 1222; // Actual parsed Bonsai wall, not a fabricated type.
        const child = addOrdinaryElementInStore(s.editor, anchor, {
          kind: 'beam', params: { Start: [0, 0, 3], End: [4, 0, 3], Width: .2, Height: .4 },
        });
        relatedIds = [child, s.editor.addEntity('IfcRelAggregates', [
          '0g8fBOlnn55vW74SLxb0PA', null, null, null, `#${oldId}`, [`#${child}`],
        ]).expressId];
      } else {
        oldId = STOREY; // Source spatial structure owns the real fixture's walls.
        relatedIds = [1222];
      }
      const beforeBytes = s.saved(), before = s.snapshot(), next = s.view.peekNextExpressId();
      const parsed = await new IfcParser().parseColumnar(beforeBytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
      expect(parsed.entityIndex.byId.has(oldId)).toBe(true);
      for (const id of relatedIds) expect(parsed.entityIndex.byId.has(id)).toBe(true);
      let prepared = false;
      expect(() => replaceElementInStore(s.store, s.editor, oldId, draft => {
        prepared = true;
        draft.addEntity('IfcCartesianPoint', [[99, 88, 77]]);
        return resolveSpatialAnchor(s.store, STOREY, draft.getMutationView());
      }, WALL)).toThrow(/replaceElementInStore:.*(unsupported|assembly)/);
      expect(prepared).toBe(false);
      expect(s.snapshot()).toEqual(before);
      expect(s.view.peekNextExpressId()).toBe(next);
      expect(s.view.isDeleted(oldId)).toBe(false);
      expect(s.saved()).toEqual(beforeBytes);
    });
  }

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
      const existing = s.snapshot(), nextId = s.view.peekNextExpressId();
      expect(() => replaceElementInStore(s.store, s.editor, id, draft => {
        draft.addEntity('IfcCartesianPoint', [[99, 88, 77]]);
        return resolveSpatialAnchor(s.store, STOREY, draft.getMutationView());
      }, invalid)).toThrow(/not a valid 22-character IFC GUID/);
      expect(s.snapshot()).toEqual(existing);
      expect(s.view.peekNextExpressId()).toBe(nextId);
      expect(s.view.isDeleted(id)).toBe(false);
      const replacement = replaceElementInStore(s.store, s.editor, id,
        draft => resolveSpatialAnchor(s.store, STOREY, draft.getMutationView()), element);
      expect(replacement.removedIds).toEqual([id]);
      expect(s.view.isDeleted(id)).toBe(true);
      expect(s.view.getNewEntity(replacement.expressId)?.type.toUpperCase()).toBe(`IFC${element.kind.toUpperCase()}`);
      const replaced = await new IfcParser().parseColumnar(s.saved().slice().buffer as ArrayBuffer, { disableWorkerScan: true });
      expect(replaced.entityIndex.byId.has(id)).toBe(false);
      expect(replaced.entityIndex.byId.has(replacement.expressId)).toBe(true);
      expect(replaced.entityIndex.byId.has(s.prior)).toBe(true);
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
