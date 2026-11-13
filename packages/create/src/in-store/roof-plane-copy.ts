/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { EntityExtractor, extractPropertiesOnDemand, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { getFootprintRoofPlaneParts, PART_TYPE, RELATION_NAME } from './roof-plane-parts.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';
import { collectSourceAssociations } from './resolve-source.js';
import { ROOF_FOOTPRINT_PSET } from './roof-footprint.js';

/** Quantitative parts follow a copied roof without becoming placed/meshed
 * assembly children. Saved definitions retain their normal association policy;
 * standard measurements also remain readable in the current overlay. */
export function copyRoofPlaneParts(store: IfcDataStore, editor: StoreEditor, source: number, target: number,
  random?: RandomSource): Map<number, number> {
  const view = editor.getMutationView(), parts = getFootprintRoofPlaneParts(store, view, source);
  const copied = new Map<number, number>();
  if (!parts.length) return copied;
  if (parts.length > 10_000) throw new Error('Roof plane copy exceeds 10000 parts');
  if (!store.source) throw new Error('Roof plane copy requires source bytes');
  const reader = new AnchorEntityReader(store, view), extractor = new EntityExtractor(store.source);
  const guid = () => generateIfcGuid(random);
  const copyMeasurements = (original: number, id: number, quantitySet: string, propertySet: string) => {
    const sourceQuantities = view.getQuantitiesForEntity(original);
    const quantities = sourceQuantities.length || view.hasChanges(original) ? sourceQuantities : extractQuantitiesOnDemand(store, original);
    for (const set of quantities.filter(set => set.name === quantitySet)) for (const q of set.quantities) {
      view.setQuantity(id, set.name, q.name, q.value, q.type);
    }
    const sourceProperties = view.getForEntity(original);
    const properties = sourceProperties.length || view.hasChanges(original) ? sourceProperties : extractPropertiesOnDemand(store, original);
    for (const set of properties.filter(set => set.name === propertySet)) for (const p of set.properties) {
      view.setProperty(id, set.name, p.name, p.value, p.type, p.unit, false, p.dataType);
    }
  };
  for (const original of parts) {
    const a = reader.entity(original)!.attributes;
    if (a[5] != null || a[6] != null) throw new Error('Quantitative roof parts with independent placement or geometry cannot be copied');
    const text = (index: number) => typeof a[index] === 'string' ? a[index] : null;
    const ownerId = refId(a[1]), owner = ownerId === null ? null : `#${ownerId}`;
    const id = editor.addEntity('IfcSlab', [guid(), owner, text(2), text(3), PART_TYPE, null, null, text(7), '.ROOF.']).expressId;
    copied.set(id, original);
    for (const association of collectSourceAssociations(store, extractor, original, editor)) {
      for (const definition of association.relatingExpressIds ?? [association.relatingExpressId]) {
        editor.addEntity(association.relType, [guid(), association.ownerHistoryId === null ? null : `#${association.ownerHistoryId}`,
          association.name, association.description, [`#${id}`], `#${definition}`]);
      }
    }
    copyMeasurements(original, id, 'Qto_SlabBaseQuantities', 'Pset_SlabCommon');
  }
  const roof = reader.entity(target)!, ownerId = refId(roof.attributes[1]);
  editor.addEntity('IfcRelAssignsToProduct', [guid(), ownerId === null ? null : `#${ownerId}`,
    RELATION_NAME, null, [...copied.keys()].map(id => `#${id}`), null, `#${target}`]);
  copyMeasurements(source, target, 'Qto_RoofBaseQuantities', ROOF_FOOTPRINT_PSET);
  return copied;
}
