/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { resolveSpatialAnchor, AnchorEntityReader } from './resolve-anchor.js';
import { splitElementInStore } from './element-split.js';
import { asRef, refList } from './style-entity-reader.js';

it.each(['wall', 'space'] as const)('#6232 persisted %s split keeps actual Pset/Qto references and fresh target quantities', async kind => {
  const bytes = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  let store = await parse(bytes), view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 42, view);
  const id = addOrdinaryElementInStore(editor, anchor, kind === 'wall'
    ? { kind: 'wall', params: { Start: [10, 10, 0], End: [18, 10, 0], Thickness: .2, Height: 3 } }
    : { kind: 'space', params: { Position: [10, 10, 0], Width: 8, Depth: 6, Height: 3 } });
  // Importer-supplied metadata is preserved, never guessed from new geometry.
  editor.addPropertySet(id, 'Pset_ImportedAudit', [{ name: 'AuditCode', type: 'INTEGER', value: id }]);
  editor.addQuantitySet(id, 'Qto_ImportedAudit', [{ name: 'DeclaredCount', quantityType: 'COUNT', value: 17 }]);
  const exported = () => new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  store = await parse(exported()); view = new MutablePropertyView(null, 'm'); editor = new StoreEditor(store, view);
  const properties = extractPropertiesOnDemand(store, id), quantities = extractQuantitiesOnDemand(store, id);
  expect(properties.length).toBeGreaterThan(0);
  expect(quantities.length).toBeGreaterThan(0);
  const result = splitElementInStore(store, editor, id, kind === 'wall'
    ? { kind: 'wall', distance: 2 }
    : { kind: 'slab', a: [12, -10], b: [12, 30] });
  const reparsed = await parse(exported());
  const sourceProperties = extractPropertiesOnDemand(reparsed, id), addedProperties = extractPropertiesOnDemand(reparsed, result.addedId);
  const sourceQuantities = extractQuantitiesOnDemand(reparsed, id), addedQuantities = extractQuantitiesOnDemand(reparsed, result.addedId);
  for (const set of properties) {
    expect(sourceProperties.find(actual => actual.globalId === set.globalId)).toEqual(set);
    if (set.name !== 'Pset_SpaceCommon') expect(addedProperties.find(actual => actual.globalId === set.globalId)).toEqual(set);
  }
  for (const set of quantities) {
    expect(sourceQuantities.find(actual => actual.globalId === set.globalId)).toEqual(set);
    if (set.name !== 'Qto_SpaceBaseQuantities') expect(addedQuantities.find(actual => actual.globalId === set.globalId)).toEqual(set);
  }
  if (kind === 'space') {
    // Extractor name deduplication must not conceal duplicate IFC memberships.
    const reader = new AnchorEntityReader(reparsed, null);
    const definitions = [...reader.ids('IFCRELDEFINESBYPROPERTIES')].flatMap(relId => {
      const rel = reader.entity(relId);
      if (!refList(rel?.attributes[4]).includes(result.addedId)) return [];
      const definitionId = asRef(rel?.attributes[5]);
      const definition = definitionId === null ? null : reader.entity(definitionId);
      return definition ? [definition] : [];
    });
    expect(definitions.filter(set => set.attributes[2] === 'Qto_SpaceBaseQuantities')).toHaveLength(1);
    expect(definitions.filter(set => set.attributes[2] === 'Pset_SpaceCommon')).toHaveLength(1);
    const common = addedProperties.filter(set => set.name === 'Pset_SpaceCommon');
    expect(common).toHaveLength(1);
    expect(common[0].properties.find(property => property.name === 'GrossPlannedArea')?.value).toBe(12);
    const base = addedQuantities.filter(set => set.name === 'Qto_SpaceBaseQuantities');
    expect(base).toHaveLength(1);
    expect(base[0].quantities.find(quantity => quantity.name === 'NetFloorArea')?.value).toBe(12);
    expect(base[0].quantities.find(quantity => quantity.name === 'GrossVolume')?.value).toBe(36);
  }
});
