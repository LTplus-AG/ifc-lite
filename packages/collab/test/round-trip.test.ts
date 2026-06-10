/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Round-trip seed/snapshot tests against the buildingSMART hello-wall
 * fixture. Seeding → snapshotting → re-seeding must converge to the same
 * Y state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCollabDoc, entitiesMap } from '../src/doc/schema.js';
import {
  addClassification,
  addMaterial,
  createEntity,
  entityToJSON,
  getEntity,
  getGeometryRef,
  setAttribute,
  setGeometryRef,
  setPropertyValue,
  setQuantityValue,
} from '../src/doc/entity.js';
import { createGeometry, getGeometry } from '../src/doc/geometry.js';
import { seedFromIfcx } from '../src/snapshot/from-ifcx.js';
import { snapshotToIfcx } from '../src/snapshot/to-ifcx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fixturesDir = path.join(repoRoot, 'tests/models/ifc5');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

function summarise(doc: ReturnType<typeof createCollabDoc>): {
  entityPaths: string[];
  attrCount: number;
} {
  const ents = entitiesMap(doc);
  const paths = Array.from(ents.keys()).sort();
  let attrCount = 0;
  for (const [, e] of ents.entries()) {
    const json = entityToJSON(e);
    attrCount += Object.keys(json.attributes).length;
  }
  return { entityPaths: paths, attrCount };
}

describe('seedFromIfcx + snapshotToIfcx', () => {
  it('preserves entity set and attributes across one round-trip', () => {
    const text = loadFixture('Hello_Wall_hello-wall.ifcx');
    const docA = createCollabDoc();
    seedFromIfcx(docA, text);
    const summaryA = summarise(docA);
    expect(summaryA.entityPaths.length).toBeGreaterThan(0);

    const ifcx = snapshotToIfcx(docA);
    expect(ifcx.data.length).toBe(summaryA.entityPaths.length);

    const docB = createCollabDoc();
    seedFromIfcx(docB, ifcx);
    const summaryB = summarise(docB);

    expect(summaryB.entityPaths).toEqual(summaryA.entityPaths);
    expect(summaryB.attrCount).toBe(summaryA.attrCount);
  });

  it('idempotent re-seed against same source', () => {
    const text = loadFixture('Hello_Wall_hello-wall.ifcx');
    const doc = createCollabDoc();
    seedFromIfcx(doc, text);
    const before = summarise(doc);
    seedFromIfcx(doc, text);
    const after = summarise(doc);
    expect(after.entityPaths).toEqual(before.entityPaths);
    expect(after.attrCount).toBe(before.attrCount);
  });
});

describe('structured branches across snapshot → seed (#1031)', () => {
  function makeStructuredDoc() {
    const doc = createCollabDoc();
    createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
    setAttribute(doc, 'wall', 'bsi::ifc::class', { code: 'IfcWall' });
    setPropertyValue(doc, 'wall', 'Pset_FireSafety', 'FireRating', {
      type: 'IfcLabel',
      value: 'F30',
      source: 'manual',
    });
    setPropertyValue(doc, 'wall', 'Pset_WallCommon', 'IsExternal', {
      type: 'IfcBoolean',
      value: true,
    });
    setQuantityValue(doc, 'wall', 'Qto_WallBaseQuantities', 'NetVolume', 12.5);
    addClassification(doc, 'wall', {
      system: 'eBKP-H',
      code: 'C2.1',
      uri: 'https://example.org/ebkp/C2.1',
    });
    addMaterial(doc, 'wall', { materialId: 'mat-concrete', layerName: 'core', thickness: 0.2 });
    setGeometryRef(doc, 'wall', { geomId: 'geom-1' });
    return doc;
  }

  it('pset/quantity/classification/material/geometryRef survive one round-trip', () => {
    const docA = makeStructuredDoc();
    const ifcx = snapshotToIfcx(docA);

    // Wire form: structured branches travel as namespaced attributes.
    const wallNode = ifcx.data.find((n) => n.path === 'wall')!;
    expect(wallNode.attributes?.['bsi::ifc::v5a::Pset_FireSafety::FireRating']).toEqual({
      type: 'IfcLabel',
      value: 'F30',
      source: 'manual',
    });
    expect(wallNode.attributes?.['bsi::ifc::v5a::Qto_WallBaseQuantities::NetVolume']).toBe(12.5);
    expect(wallNode.attributes?.['ifclite::classifications']).toEqual([
      { system: 'eBKP-H', code: 'C2.1', uri: 'https://example.org/ebkp/C2.1' },
    ]);
    expect(wallNode.attributes?.['ifclite::materials']).toEqual([
      { materialId: 'mat-concrete', layerName: 'core', thickness: 0.2 },
    ]);
    expect(wallNode.attributes?.['ifclite::geometryRef']).toBe('geom-1');

    const docB = createCollabDoc();
    seedFromIfcx(docB, ifcx);
    const wallA = entityToJSON(getEntity(docA, 'wall')!);
    const wallB = entityToJSON(getEntity(docB, 'wall')!);

    expect(wallB.psets).toEqual(wallA.psets);
    expect(wallB.quantities).toEqual(wallA.quantities);
    expect(wallB.classifications).toEqual(wallA.classifications);
    expect(wallB.materials).toEqual(wallA.materials);
    expect(wallB.geometryRef).toBe('geom-1');
    // The folded keys must not linger in the flat attributes branch.
    expect(wallB.attributes).toEqual({ 'bsi::ifc::class': { code: 'IfcWall' } });

    // Second round-trip is a fixed point.
    expect(snapshotToIfcx(docB).data).toEqual(ifcx.data);
  });

  it('legacy migrated raw values under v5a keys stay flat attributes', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    // The IFC4→5 migration writes raw scalars (only ever under Pset_*
    // set names), not PropertyValue shapes.
    setAttribute(doc, 'wall', 'bsi::ifc::v5a::Pset_WallCommon::FireRating', 'F30');
    setAttribute(doc, 'wall', 'bsi::ifc::v5a::Pset_WallCommon::Width', 0.3);

    const ifcx = snapshotToIfcx(doc);
    const docB = createCollabDoc();
    seedFromIfcx(docB, ifcx);
    const wall = entityToJSON(getEntity(docB, 'wall')!);
    expect(wall.attributes['bsi::ifc::v5a::Pset_WallCommon::FireRating']).toBe('F30');
    expect(wall.attributes['bsi::ifc::v5a::Pset_WallCommon::Width']).toBe(0.3);
    expect(wall.psets).toEqual({});
    expect(wall.quantities).toEqual({});
  });

  it('geometry refs carry their record so seeds never restore a dangling pointer', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    createGeometry(doc, 'geom-7', {
      type: 'parametric',
      source: 'extruded-area-solid',
      blobHash: 'blake3:abc',
      params: { depth: 0.3 },
      bbox: [0, 0, 0, 1, 1, 1],
    });
    setGeometryRef(doc, 'wall', { geomId: 'geom-7' });

    const ifcx = snapshotToIfcx(doc);
    const node = ifcx.data.find((n) => n.path === 'wall')!;
    expect(node.attributes?.['ifclite::geometryRef']).toEqual({
      geomId: 'geom-7',
      type: 'parametric',
      source: 'extruded-area-solid',
      blobHash: 'blake3:abc',
      params: { depth: 0.3 },
      bbox: [0, 0, 0, 1, 1, 1],
    });

    const docB = createCollabDoc();
    seedFromIfcx(docB, ifcx);
    expect(getGeometryRef(docB, 'wall')).toEqual({ geomId: 'geom-7' });
    const restored = getGeometry(docB, 'geom-7');
    expect(restored).toBeDefined();
    expect(restored!.get('blobHash')).toBe('blake3:abc');

    // Fixed point: the re-seeded doc snapshots to the same wire form.
    expect(snapshotToIfcx(docB).data).toEqual(ifcx.data);
  });

  it('typed records under Qto_* sets inflate into quantities, not psets', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    // Wire shape a draft set_property op produces when an agent targets
    // a quantity set: typed record under a Qto_* key.
    setAttribute(doc, 'wall', 'bsi::ifc::v5a::Qto_WallBaseQuantities::NetArea', {
      type: 'IfcReal',
      value: 12.5,
    });

    const docB = createCollabDoc();
    seedFromIfcx(docB, snapshotToIfcx(doc));
    const wall = entityToJSON(getEntity(docB, 'wall')!);
    expect(wall.quantities).toEqual({ Qto_WallBaseQuantities: { NetArea: 12.5 } });
    expect(wall.psets).toEqual({});
    // Re-flattened canonical shape is the raw number (quantities branch
    // stores plain numbers) — second round-trip is a fixed point.
    const second = snapshotToIfcx(docB);
    expect(
      second.data.find((n) => n.path === 'wall')!.attributes?.[
        'bsi::ifc::v5a::Qto_WallBaseQuantities::NetArea'
      ],
    ).toBe(12.5);
  });

  it('custom (non-Qto_) quantity-set names round-trip into the quantities branch', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    setQuantityValue(doc, 'wall', 'CarbonMetrics', 'EmbodiedCO2', 412.5);

    const ifcx = snapshotToIfcx(doc);
    const docB = createCollabDoc();
    seedFromIfcx(docB, ifcx);
    const wall = entityToJSON(getEntity(docB, 'wall')!);
    expect(wall.quantities).toEqual({ CarbonMetrics: { EmbodiedCO2: 412.5 } });
    expect(wall.attributes).not.toHaveProperty('bsi::ifc::v5a::CarbonMetrics::EmbodiedCO2');
  });

  it('rejects set/member names containing the :: wire delimiter', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    expect(() =>
      setPropertyValue(doc, 'wall', 'Pset_A::B', 'Prop', { type: 'IfcLabel', value: 'x' }),
    ).toThrow(/must not contain "::"/);
    expect(() =>
      setPropertyValue(doc, 'wall', 'Pset_A', 'Prop::Sub', { type: 'IfcLabel', value: 'x' }),
    ).toThrow(/must not contain "::"/);
    expect(() => setQuantityValue(doc, 'wall', 'Qto_A::B', 'NetArea', 1)).toThrow(
      /must not contain "::"/,
    );
    expect(() =>
      createEntity(doc, 'slab', { psets: { 'Pset_A::B': { P: { type: 'IfcLabel', value: 'x' } } } }),
    ).toThrow(/must not contain "::"/);
  });

  it('structured pset wins over a colliding flat attribute deterministically', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    setAttribute(doc, 'wall', 'bsi::ifc::v5a::Pset_FireSafety::FireRating', 'stale-flat');
    setPropertyValue(doc, 'wall', 'Pset_FireSafety', 'FireRating', {
      type: 'IfcLabel',
      value: 'F60',
    });

    const ifcx = snapshotToIfcx(doc);
    const node = ifcx.data.find((n) => n.path === 'wall')!;
    expect(node.attributes?.['bsi::ifc::v5a::Pset_FireSafety::FireRating']).toEqual({
      type: 'IfcLabel',
      value: 'F60',
    });
  });
});
