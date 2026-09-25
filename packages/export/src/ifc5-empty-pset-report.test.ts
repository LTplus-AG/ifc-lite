/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5201: an empty property set (`createPropertySet(id, name, [])`) silently
 * vanished from the IFCX export — `getPropertiesForEntity`'s inner loop only
 * ever writes by iterating `pset.properties`, so a pset with zero properties
 * contributes nothing to the output, and `stats.propertyCount`/`nodeCount`
 * still reported success. `apps/viewer/src/lib/layers/publish.ts` hit the
 * identical wire-dialect limitation under #2277 and reports it as
 * `skippedCount`/`unrepresentedOps` instead of dropping it — this mirrors
 * that name and shape in `Ifc5ExportResult.stats`
 * (`skippedCount`/`unrepresentedPropertySets`).
 *
 * The live caller is `apps/viewer/src/lib/export/changed-model-export.ts`'s
 * Export Changes -> IFCX path, which sets `onlyKnownProperties: false`
 * *specifically* so edits are not silently dropped — the exact input these
 * tests drive.
 */

import { describe, it, expect } from 'vitest';
import { Ifc5Exporter } from './ifc5-exporter.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  RelationshipGraphBuilder,
  QuantityTableBuilder,
} from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';

function buildOneWallDataStore(): IfcDataStore {
  const strings = new StringTable();
  const entityBuilder = new EntityTableBuilder(1, strings);
  entityBuilder.add(1, 'IFCWALL', 'wall-1-guid', 'Wall1', '', '');
  return {
    fileSize: 0,
    schemaVersion: 'IFC4',
    entityCount: 1,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
    strings,
    entities: entityBuilder.build(),
    properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: new RelationshipGraphBuilder().build(),
  } as unknown as IfcDataStore;
}

describe('Ifc5Exporter empty-pset reporting (#5201)', () => {
  it('reports an empty property set as skipped instead of silently dropping it', () => {
    const dataStore = buildOneWallDataStore();
    const view = new MutablePropertyView(null, 'm1');
    // The issue's exact repro: a pset materialized with zero properties.
    view.createPropertySet(1, 'Pset_Empty', []);

    const exporter = new Ifc5Exporter(dataStore, null, view);
    const result = exporter.export({
      onlyTreeEntities: false,
      applyMutations: true,
      // The live "Export Changes -> IFCX" caller sets this explicitly so
      // edits are not silently dropped — the exact condition #5201 defeats.
      onlyKnownProperties: false,
    });
    const file = JSON.parse(result.content);

    // The loss must be reported: this is the assertion that can only pass
    // with the feature present. Before the fix, `stats` carried no
    // `skippedCount`/`unrepresentedPropertySets` field at all, and after a
    // naive "always report 0" regression it would read 0 here.
    expect(result.stats.skippedCount).toBe(1);
    expect(result.stats.unrepresentedPropertySets).toEqual([
      { entityId: 1, psetName: 'Pset_Empty' },
    ]);

    // The wall node still exists (it is not the *entity* that vanished, the
    // pset had zero wire representation), but nothing in its attributes
    // traces `Pset_Empty` — confirming the loss the stat now reports.
    const wallNode = file.data.find(
      (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Wall1',
    );
    expect(wallNode).toBeDefined();
    const psetKeys = Object.keys(wallNode.attributes ?? {}).filter((k) =>
      k.startsWith('bsi::ifc::prop::'),
    );
    // Only the core `Name` attribute is bsi::ifc::prop::-namespaced here;
    // nothing from Pset_Empty made it into the output.
    expect(psetKeys).toEqual(['bsi::ifc::prop::Name']);
  });

  it('a normal non-empty pset still exports identically, with skippedCount at zero', () => {
    const dataStore = buildOneWallDataStore();
    const view = new MutablePropertyView(null, 'm1');
    view.createPropertySet(1, 'Pset_FireSafety', [{ name: 'FireRating', value: 'REI90' }]);

    const exporter = new Ifc5Exporter(dataStore, null, view);
    const result = exporter.export({
      onlyTreeEntities: false,
      applyMutations: true,
      onlyKnownProperties: false,
    });
    const file = JSON.parse(result.content);

    expect(result.stats.skippedCount).toBe(0);
    expect(result.stats.unrepresentedPropertySets).toEqual([]);

    const wallNode = file.data.find(
      (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Wall1',
    );
    // Pset-qualified since #5376: `FireRating` has no official flat IFC5 key.
    expect(wallNode.attributes['bsi::ifc::v5a::Pset_FireSafety::FireRating']).toEqual({ type: 'IfcText', value: 'REI90' });
  });

  it('mixed: an empty pset is reported while a real pset on the same entity still exports', () => {
    const dataStore = buildOneWallDataStore();
    const view = new MutablePropertyView(null, 'm1');
    view.createPropertySet(1, 'Pset_Empty', []);
    view.createPropertySet(1, 'Pset_FireSafety', [{ name: 'FireRating', value: 'REI90' }]);

    const exporter = new Ifc5Exporter(dataStore, null, view);
    const result = exporter.export({
      onlyTreeEntities: false,
      applyMutations: true,
      onlyKnownProperties: false,
    });
    const file = JSON.parse(result.content);

    expect(result.stats.skippedCount).toBe(1);
    expect(result.stats.unrepresentedPropertySets).toEqual([
      { entityId: 1, psetName: 'Pset_Empty' },
    ]);
    const wallNode = file.data.find(
      (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Wall1',
    );
    // Pset-qualified since #5376: `FireRating` has no official flat IFC5 key.
    expect(wallNode.attributes['bsi::ifc::v5a::Pset_FireSafety::FireRating']).toEqual({ type: 'IfcText', value: 'REI90' });
  });
});
