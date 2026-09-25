/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5376: `Ifc5Exporter` wrote every pset property under the flat
 * `bsi::ifc::prop::<Name>` key, so two psets sharing a property name collided
 * (last write won, silently) and import could never tell which pset a
 * property came from. The exporter now writes the pset-qualified
 * `bsi::ifc::v5a::<Pset>::<Name>` key in full-fidelity mode, keeps the flat
 * key only for names the official IFC5 property schema defines, and reports
 * a flat-key collision in `stats.propertyCollisions`.
 */

import { describe, it, expect } from 'vitest';
import { parseIfcx } from '@ifc-lite/ifcx';
import { MutablePropertyView } from '@ifc-lite/mutations';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  PropertyValueType,
  RelationshipGraphBuilder,
  QuantityTableBuilder,
} from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { Ifc5Exporter } from './ifc5-exporter.js';
import { IFC_PROP_SCHEMAS } from './__fixtures__/ifc5-official-schemas.js';

function buildOneWallDataStore(): IfcDataStore {
  const strings = new StringTable();
  const entityBuilder = new EntityTableBuilder(1, strings);
  entityBuilder.add(1, 'IFCWALL', 'wall-1-guid', 'Wall-001', '', '');
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

/** Two psets that share a custom name (`Reference`) and an official one (`IsExternal`). */
function exportCollidingPsets(onlyKnownProperties: boolean) {
  const view = new MutablePropertyView(null, 'm1');
  view.createPropertySet(1, 'Pset_A', [
    { name: 'Reference', value: 'from-A', type: PropertyValueType.Label },
    { name: 'IsExternal', value: true, type: PropertyValueType.Boolean },
  ]);
  view.createPropertySet(1, 'Pset_B', [
    { name: 'Reference', value: 'from-B', type: PropertyValueType.Label },
    { name: 'IsExternal', value: false, type: PropertyValueType.Boolean },
  ]);
  const result = new Ifc5Exporter(buildOneWallDataStore(), null, view).export({
    onlyTreeEntities: false,
    applyMutations: true,
    onlyKnownProperties,
  });
  const wall = (JSON.parse(result.content).data as { attributes?: Record<string, unknown> }[])
    .find((node) => node.attributes?.['bsi::ifc::prop::Name'] === 'Wall-001');
  return { result, attributes: wall?.attributes ?? {} };
}

async function reimportedPsets(content: string) {
  const store = await parseIfcx(new TextEncoder().encode(content).buffer as ArrayBuffer);
  for (let i = 0; i < store.entities.count; i++) {
    if (store.strings.get(store.entities.name[i]) === 'Wall-001') {
      return store.properties.getForEntity(store.entities.expressId[i]);
    }
  }
  throw new Error('wall not found after re-import');
}

describe('Ifc5Exporter pset-qualified keys (#5376)', () => {
  it('keeps both psets\' values under pset-qualified keys in full-fidelity mode', () => {
    const { attributes } = exportCollidingPsets(false);
    expect(attributes['bsi::ifc::v5a::Pset_A::Reference']).toEqual({ type: 'IfcLabel', value: 'from-A' });
    expect(attributes['bsi::ifc::v5a::Pset_B::Reference']).toEqual({ type: 'IfcLabel', value: 'from-B' });
    // `Reference` has no official schema, so no flat key is written for it.
    expect(attributes['bsi::ifc::prop::Reference']).toBeUndefined();
  });

  it('writes the flat key only for names the official IFC5 property schema defines', () => {
    const { attributes } = exportCollidingPsets(false);
    expect(IFC_PROP_SCHEMAS['bsi::ifc::prop::IsExternal']).toBeDefined();
    expect(IFC_PROP_SCHEMAS['bsi::ifc::prop::Reference']).toBeUndefined();
    expect(attributes['bsi::ifc::prop::IsExternal']).toBe(false);
    for (const key of Object.keys(attributes).filter((k) => k.startsWith('bsi::ifc::prop::'))) {
      expect(IFC_PROP_SCHEMAS[key], key).toBeDefined();
    }
  });

  it('reports the flat-key collision, marking whether a value was lost', () => {
    const full = exportCollidingPsets(false).result.stats.propertyCollisions;
    expect(full).toEqual([{ entityId: 1, propertyName: 'IsExternal', psetNames: ['Pset_A', 'Pset_B'], valueLost: false }]);
    const official = exportCollidingPsets(true).result.stats.propertyCollisions;
    expect(official).toEqual([{ entityId: 1, propertyName: 'IsExternal', psetNames: ['Pset_A', 'Pset_B'], valueLost: true }]);
  });

  it('default mode writes official flat keys only, as before', () => {
    const { attributes } = exportCollidingPsets(true);
    expect(Object.keys(attributes).some((k) => k.startsWith('bsi::ifc::v5a::'))).toBe(false);
    expect(attributes['bsi::ifc::prop::IsExternal']).toBe(false);
  });

  it('import restores each pset, without a duplicate from the flat mirror', async () => {
    const { result } = exportCollidingPsets(false);
    const psets = await reimportedPsets(result.content);
    const byName = new Map(psets.map((p) => [p.name, new Map(p.properties.map((q) => [q.name, q.value]))]));
    expect(byName.get('Pset_A')?.get('Reference')).toBe('from-A');
    expect(byName.get('Pset_B')?.get('Reference')).toBe('from-B');
    expect(byName.get('Pset_A')?.get('IsExternal')).toBe(true);
    expect(byName.get('Pset_B')?.get('IsExternal')).toBe(false);
    // The flat IsExternal mirrors Pset_B's value, so it is not listed again.
    expect(byName.get('IFC Properties')?.has('IsExternal') ?? false).toBe(false);
  });
});
