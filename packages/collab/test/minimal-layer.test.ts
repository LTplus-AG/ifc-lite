/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { composeIfcx, type IfcxFile } from '@ifc-lite/ifcx';
import { createCollabDoc } from '../src/doc/schema.js';
import {
  addClassification,
  addMaterial,
  clearGeometryRef,
  createEntity,
  deletePropertyValue,
  deleteQuantityValue,
  removeClassification,
  removeMaterial,
  setAttribute,
  setChild,
  setGeometryRef,
  setPropertyValue,
  setQuantityValue,
} from '../src/doc/entity.js';
import { extractMinimalLayer } from '../src/snapshot/minimal-layer.js';
import { snapshotToIfcx } from '../src/snapshot/to-ifcx.js';

describe('extractMinimalLayer', () => {
  it('emits only entities created or updated since baseline', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
    setAttribute(doc, 'wall', 'Name', 'baseline-name');
    const baseline = Y.encodeStateAsUpdate(doc);

    // Mutate after baseline.
    createEntity(doc, 'window');
    setAttribute(doc, 'wall', 'Description', 'added-after-baseline');

    const layer = extractMinimalLayer(doc, baseline);
    const paths = layer.data.map((n) => n.path).sort();
    expect(paths).toEqual(['wall', 'window']);

    const wall = layer.data.find((n) => n.path === 'wall')!;
    // Description was added → must appear.
    expect(wall.attributes?.Description).toBe('added-after-baseline');
    // Name was unchanged → must NOT appear.
    expect(wall.attributes?.Name).toBeUndefined();

    const window = layer.data.find((n) => n.path === 'window')!;
    // New entity has whatever attributes it carries (here: bsi::ifc::class
    // was never set explicitly, so attributes may be empty / absent).
    expect(window.path).toBe('window');
  });

  it('treats updated values as diffs by default', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    setAttribute(doc, 'wall', 'Name', 'first');
    const baseline = Y.encodeStateAsUpdate(doc);

    setAttribute(doc, 'wall', 'Name', 'second');

    const layer = extractMinimalLayer(doc, baseline);
    const wall = layer.data.find((n) => n.path === 'wall')!;
    expect(wall.attributes?.Name).toBe('second');
  });

  it('with includeUpdatedValues:false only emits brand-new keys', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    setAttribute(doc, 'wall', 'Name', 'first');
    const baseline = Y.encodeStateAsUpdate(doc);

    setAttribute(doc, 'wall', 'Name', 'second');
    setAttribute(doc, 'wall', 'Description', 'new-key');

    const layer = extractMinimalLayer(doc, baseline, { includeUpdatedValues: false });
    const wall = layer.data.find((n) => n.path === 'wall');
    expect(wall?.attributes?.Description).toBe('new-key');
    expect(wall?.attributes?.Name).toBeUndefined();
  });

  it('captures children diffs', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'storey');
    createEntity(doc, 'wall');
    const baseline = Y.encodeStateAsUpdate(doc);

    setChild(doc, 'storey', 'Wall', 'wall');

    const layer = extractMinimalLayer(doc, baseline);
    const storey = layer.data.find((n) => n.path === 'storey');
    expect(storey?.children).toEqual({ Wall: 'wall' });
  });

  it('round-trip: baseline + minimal layer composes back to live state for entity set', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'a');
    createEntity(doc, 'b');
    setAttribute(doc, 'a', 'Name', 'A1');
    const baseline = Y.encodeStateAsUpdate(doc);

    createEntity(doc, 'c');
    setAttribute(doc, 'a', 'Description', 'A-desc');

    const layer = extractMinimalLayer(doc, baseline);
    // The live doc has {a, b, c}; the baseline doc has {a, b}; the
    // minimal layer must mention {a (changed), c (new)} and nothing
    // else.
    const layerPaths = new Set(layer.data.map((n) => n.path));
    expect(layerPaths.has('a')).toBe(true);
    expect(layerPaths.has('c')).toBe(true);
    expect(layerPaths.has('b')).toBe(false);
  });

  describe('structured branches (#1031)', () => {
    it('pset property add / update / delete surface as namespaced attribute diffs', () => {
      const doc = createCollabDoc();
      createEntity(doc, 'wall');
      setPropertyValue(doc, 'wall', 'Pset_FireSafety', 'FireRating', {
        type: 'IfcLabel',
        value: 'F30',
      });
      setPropertyValue(doc, 'wall', 'Pset_FireSafety', 'Combustible', {
        type: 'IfcBoolean',
        value: false,
      });
      setPropertyValue(doc, 'wall', 'Pset_WallCommon', 'IsExternal', {
        type: 'IfcBoolean',
        value: true,
      });
      const baseline = Y.encodeStateAsUpdate(doc);

      setPropertyValue(doc, 'wall', 'Pset_FireSafety', 'FireRating', {
        type: 'IfcLabel',
        value: 'F60',
      });
      setPropertyValue(doc, 'wall', 'Pset_WallCommon', 'LoadBearing', {
        type: 'IfcBoolean',
        value: true,
      });
      deletePropertyValue(doc, 'wall', 'Pset_FireSafety', 'Combustible');

      const layer = extractMinimalLayer(doc, baseline);
      const wall = layer.data.find((n) => n.path === 'wall')!;
      expect(wall.attributes?.['bsi::ifc::v5a::Pset_FireSafety::FireRating']).toEqual({
        type: 'IfcLabel',
        value: 'F60',
      });
      expect(wall.attributes?.['bsi::ifc::v5a::Pset_WallCommon::LoadBearing']).toEqual({
        type: 'IfcBoolean',
        value: true,
      });
      // Removed property → null removal marker.
      expect(wall.attributes?.['bsi::ifc::v5a::Pset_FireSafety::Combustible']).toBeNull();
      // Untouched property must not appear.
      expect(wall.attributes).not.toHaveProperty('bsi::ifc::v5a::Pset_WallCommon::IsExternal');
    });

    it('quantity add and delete surface as diffs', () => {
      const doc = createCollabDoc();
      createEntity(doc, 'wall');
      setQuantityValue(doc, 'wall', 'Qto_WallBaseQuantities', 'NetVolume', 12.5);
      const baseline = Y.encodeStateAsUpdate(doc);

      setQuantityValue(doc, 'wall', 'Qto_WallBaseQuantities', 'NetArea', 8.75);
      deleteQuantityValue(doc, 'wall', 'Qto_WallBaseQuantities', 'NetVolume');

      const layer = extractMinimalLayer(doc, baseline);
      const wall = layer.data.find((n) => n.path === 'wall')!;
      expect(wall.attributes?.['bsi::ifc::v5a::Qto_WallBaseQuantities::NetArea']).toBe(8.75);
      expect(wall.attributes?.['bsi::ifc::v5a::Qto_WallBaseQuantities::NetVolume']).toBeNull();
    });

    it('classification / material / geometryRef changes surface as diffs', () => {
      const doc = createCollabDoc();
      createEntity(doc, 'wall');
      addClassification(doc, 'wall', { system: 'eBKP-H', code: 'C2.1' });
      addMaterial(doc, 'wall', { materialId: 'mat-1' });
      setGeometryRef(doc, 'wall', { geomId: 'geom-1' });
      const baseline = Y.encodeStateAsUpdate(doc);

      addClassification(doc, 'wall', { system: 'Uniclass', code: 'EF_25_10' });
      removeMaterial(doc, 'wall', 0);
      setGeometryRef(doc, 'wall', { geomId: 'geom-2' });

      const layer = extractMinimalLayer(doc, baseline);
      const wall = layer.data.find((n) => n.path === 'wall')!;
      expect(wall.attributes?.['ifclite::classifications']).toEqual([
        { system: 'eBKP-H', code: 'C2.1' },
        { system: 'Uniclass', code: 'EF_25_10' },
      ]);
      // Materials array emptied → the carrier attribute is removed.
      expect(wall.attributes?.['ifclite::materials']).toBeNull();
      expect(wall.attributes?.['ifclite::geometryRef']).toBe('geom-2');
    });

    it('unchanged structured branches emit nothing', () => {
      const doc = createCollabDoc();
      createEntity(doc, 'wall');
      setPropertyValue(doc, 'wall', 'Pset_FireSafety', 'FireRating', {
        type: 'IfcLabel',
        value: 'F30',
      });
      addClassification(doc, 'wall', { system: 'eBKP-H', code: 'C2.1' });
      const baseline = Y.encodeStateAsUpdate(doc);

      removeClassification(doc, 'wall', 0);
      clearGeometryRef(doc, 'wall'); // was never set — no-op

      const layer = extractMinimalLayer(doc, baseline);
      const wall = layer.data.find((n) => n.path === 'wall')!;
      expect(wall.attributes?.['ifclite::classifications']).toBeNull();
      expect(wall.attributes).not.toHaveProperty('ifclite::geometryRef');
      expect(wall.attributes).not.toHaveProperty('bsi::ifc::v5a::Pset_FireSafety::FireRating');
    });

    it('baseline + minimal layer COMPOSE to the live state for structured deletions', () => {
      const doc = createCollabDoc();
      createEntity(doc, 'wall');
      setPropertyValue(doc, 'wall', 'Pset_FireSafety', 'FireRating', {
        type: 'IfcLabel',
        value: 'F30',
      });
      const baselineSnapshot = snapshotToIfcx(doc);
      const baseline = Y.encodeStateAsUpdate(doc);

      deletePropertyValue(doc, 'wall', 'Pset_FireSafety', 'FireRating');
      const layer = extractMinimalLayer(doc, baseline);

      // Concatenating data arrays weakest-first matches composeIfcx's
      // later-wins layer semantics (same shape bakeLayers uses).
      const merged: IfcxFile = {
        ...baselineSnapshot,
        data: [...baselineSnapshot.data, ...layer.data],
      };
      const composed = composeIfcx(merged);
      const wall = composed.get('wall');
      expect(wall).toBeDefined();
      // The null removal opinion must resolve — not survive as a null value.
      expect(wall!.attributes.has('bsi::ifc::v5a::Pset_FireSafety::FireRating')).toBe(false);
    });

    it('new entity carries its structured branches whole', () => {
      const doc = createCollabDoc();
      const baseline = Y.encodeStateAsUpdate(doc);

      createEntity(doc, 'slab', {
        psets: { Pset_SlabCommon: { IsExternal: { type: 'IfcBoolean', value: false } } },
        quantities: { Qto_SlabBaseQuantities: { GrossArea: 42 } },
        materials: [{ materialId: 'mat-screed' }],
      });

      const layer = extractMinimalLayer(doc, baseline);
      const slab = layer.data.find((n) => n.path === 'slab')!;
      expect(slab.attributes?.['bsi::ifc::v5a::Pset_SlabCommon::IsExternal']).toEqual({
        type: 'IfcBoolean',
        value: false,
      });
      expect(slab.attributes?.['bsi::ifc::v5a::Qto_SlabBaseQuantities::GrossArea']).toBe(42);
      expect(slab.attributes?.['ifclite::materials']).toEqual([{ materialId: 'mat-screed' }]);
    });
  });
});
