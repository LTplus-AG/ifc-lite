/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import { duplicateInStore, type SourceAttributes } from './duplicate.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

function baseSource(): SourceAttributes {
  return {
    type: 'IFCWALL',
    // 9-slot IfcWall: GlobalId, OwnerHistory, Name, Description, ObjectType,
    // ObjectPlacement, Representation, Tag, PredefinedType
    attributes: [
      'oldGuidXXXXXXXXXXXXXXX',
      '#5',
      'Wall A',
      null,
      'WALL',
      '#42',
      '#99',
      '12345',
      '.STANDARD.',
    ],
    placementExpressId: 42,
    parentPlacementId: 7,
    sourceLocation: [10, 20, 0],
    representationId: 99,
    ownerHistoryId: 5,
    axisRef: '#3',
    refDirectionRef: '#4',
    storeyId: 11,
  };
}

describe('duplicateInStore', () => {
  it('emits new placement chain + duplicate root + spatial rel', () => {
    const store = makeStore(100);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const result = duplicateInStore(editor, baseSource());

    expect(result.newId).toBeGreaterThan(100);
    expect(result.newPointId).toBeGreaterThan(100);
    expect(result.newAxisPlacementId).toBeGreaterThan(100);
    expect(result.newPlacementId).toBeGreaterThan(100);
    expect(result.relContainedId).toBeGreaterThan(100);

    const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));

    const point = byId.get(result.newPointId);
    expect(point?.type).toBe('IfcCartesianPoint');
    expect(point?.attributes[0]).toEqual([11, 20, 0]); // +1m on X by default

    const axis = byId.get(result.newAxisPlacementId);
    expect(axis?.type).toBe('IfcAxis2Placement3D');
    expect(axis?.attributes[0]).toBe(`#${result.newPointId}`);
    expect(axis?.attributes[1]).toBe('#3');           // Axis preserved
    expect(axis?.attributes[2]).toBe('#4');           // RefDirection preserved

    const placement = byId.get(result.newPlacementId);
    expect(placement?.type).toBe('IfcLocalPlacement');
    expect(placement?.attributes[0]).toBe('#7');      // chained to parent
    expect(placement?.attributes[1]).toBe(`#${result.newAxisPlacementId}`);

    const wall = byId.get(result.newId);
    expect(wall?.type).toBe('IFCWALL');
    expect(wall?.attributes[0]).not.toBe('oldGuidXXXXXXXXXXXXXXX'); // fresh GUID
    expect(typeof wall?.attributes[0]).toBe('string');
    expect((wall?.attributes[0] as string).length).toBe(22);
    expect(wall?.attributes[1]).toBe('#5');           // OwnerHistory preserved
    expect(wall?.attributes[2]).toBe('Wall A (copy)'); // Name suffix
    expect(wall?.attributes[5]).toBe(`#${result.newPlacementId}`);
    expect(wall?.attributes[6]).toBe('#99');           // Representation shared
    expect(wall?.attributes[8]).toBe('.STANDARD.');     // PredefinedType preserved

    const rel = byId.get(result.relContainedId!);
    expect(rel?.type).toBe('IfcRelContainedInSpatialStructure');
    expect(rel?.attributes[4]).toEqual([`#${result.newId}`]);
    expect(rel?.attributes[5]).toBe('#11');
  });

  it('honours custom offset', () => {
    const store = makeStore(100);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const result = duplicateInStore(editor, baseSource(), { offset: [0, 0, 3] });

    const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
    const point = byId.get(result.newPointId);
    expect(point?.attributes[0]).toEqual([10, 20, 3]);
  });

  it('skips spatial rel when source has no storey', () => {
    const store = makeStore(100);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const orphan: SourceAttributes = { ...baseSource(), storeyId: null };
    const result = duplicateInStore(editor, orphan);

    expect(result.relContainedId).toBeNull();
    const types = view.getNewEntities().map((e) => e.type);
    expect(types).not.toContain('IfcRelContainedInSpatialStructure');
  });

  it('uses `$` for parent placement when source sat at the spatial root', () => {
    const store = makeStore(100);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const rooted: SourceAttributes = { ...baseSource(), parentPlacementId: null };
    const result = duplicateInStore(editor, rooted);

    const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
    const placement = byId.get(result.newPlacementId);
    expect(placement?.attributes[0]).toBeNull();
  });

  it('throws when source has fewer than 7 attributes', () => {
    const store = makeStore(100);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const tiny: SourceAttributes = { ...baseSource(), attributes: ['guid', '#1', null] };
    expect(() => duplicateInStore(editor, tiny)).toThrow(/need ≥7/);
  });

  describe('association rel cloning', () => {
    it('emits one fresh rel per association so the duplicate carries the same psets/material/etc.', () => {
      const store = makeStore(200);
      const view = new MutablePropertyView(null, 'm1');
      const editor = new StoreEditor(store, view);

      const sourceWithAssocs: SourceAttributes = {
        ...baseSource(),
        associations: [
          {
            relType: 'IFCRELDEFINESBYPROPERTIES',
            ownerHistoryId: 5,
            name: 'Pset_WallCommon',
            description: null,
            relatingExpressId: 150,  // → IfcPropertySet
          },
          {
            relType: 'IFCRELASSOCIATESMATERIAL',
            ownerHistoryId: 5,
            name: null,
            description: null,
            relatingExpressId: 161,  // → IfcMaterial
          },
          {
            relType: 'IFCRELASSOCIATESCLASSIFICATION',
            ownerHistoryId: 5,
            name: null,
            description: 'Uniclass',
            relatingExpressId: 175,  // → IfcClassificationReference
          },
        ],
      };

      const result = duplicateInStore(editor, sourceWithAssocs);

      // 3 association rels emitted, each above the watermark.
      expect(result.associationRelIds).toHaveLength(3);
      for (const id of result.associationRelIds) {
        expect(id).toBeGreaterThan(200);
      }

      const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));

      // Each rel should be the right type with the duplicate as the
      // sole RelatedObject and the source's Relating* preserved.
      const propsRel = byId.get(result.associationRelIds[0]);
      expect(propsRel?.type).toBe('IFCRELDEFINESBYPROPERTIES');
      expect(propsRel?.attributes[1]).toBe('#5');                    // OwnerHistory
      expect(propsRel?.attributes[2]).toBe('Pset_WallCommon');        // Name
      expect(propsRel?.attributes[3]).toBeNull();                    // Description
      expect(propsRel?.attributes[4]).toEqual([`#${result.newId}`]);   // RelatedObjects → duplicate only
      expect(propsRel?.attributes[5]).toBe('#150');                  // RelatingPropertyDefinition

      const matRel = byId.get(result.associationRelIds[1]);
      expect(matRel?.type).toBe('IFCRELASSOCIATESMATERIAL');
      expect(matRel?.attributes[5]).toBe('#161');

      const classRel = byId.get(result.associationRelIds[2]);
      expect(classRel?.type).toBe('IFCRELASSOCIATESCLASSIFICATION');
      expect(classRel?.attributes[3]).toBe('Uniclass');               // Description preserved
      expect(classRel?.attributes[5]).toBe('#175');
    });

    it('emits no association rels when the source has none', () => {
      const store = makeStore(100);
      const view = new MutablePropertyView(null, 'm1');
      const editor = new StoreEditor(store, view);

      // baseSource() doesn't set `associations`.
      const result = duplicateInStore(editor, baseSource());
      expect(result.associationRelIds).toEqual([]);
      const types = view.getNewEntities().map((e) => e.type);
      expect(types).not.toContain('IFCRELDEFINESBYPROPERTIES');
    });
  });
});
