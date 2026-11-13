/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { EntityExtractor, extractPropertiesOnDemand, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue, StoreEditor } from '@ifc-lite/mutations';
import { getFootprintRoofPlaneParts, PART_TYPE, RELATION_NAME } from './roof-plane-parts.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';
import { collectSourceAssociations } from './resolve-source.js';
import { ROOF_FOOTPRINT_PSET } from './roof-footprint.js';
import { readFileRecord, type FileRecord } from './step-record-attrs.js';

const writesByEditor = new WeakMap<StoreEditor, number>();
const MAX_MEASUREMENT_COPY_WRITES = 10_000;

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
  const spend = (writes: number) => {
    const total = (writesByEditor.get(editor) ?? 0) + writes;
    if (total > MAX_MEASUREMENT_COPY_WRITES) throw new Error('Roof measurement copy exceeds 10000 writes in one operation');
    writesByEditor.set(editor, total);
  };
  spend(parts.length + 1);
  const reader = new AnchorEntityReader(store, view), extractor = new EntityExtractor(store.source);
  const guid = () => generateIfcGuid(random);
  const baseProperties = (base: number) => extractPropertiesOnDemand(store, base)
    .map(set => ({ ...set, globalId: set.globalId ?? '' }));
  const measurementRecord = (id: number): FileRecord | null => {
    const created = view.getNewEntity(id);
    if (!created) return readFileRecord(store, view, id);
    if (view.isDeleted(id)) return null;
    const attributes = [...created.attributes];
    for (const [index, value] of view.getPositionalMutationsForEntity(id) ?? []) attributes[index] = value as IfcAttributeValue;
    return { type: view.getEntityTypeMutation(id)?.newType ?? created.type, attributes };
  };
  const definitionForCopy = (definition: number, original: number): number | null => {
    const record = measurementRecord(definition);
    if (!record) throw new Error(`Cannot read roof measurement definition #${definition}`);
    const name = record.attributes[2], type = record.type.toUpperCase();
    let slot: number, owned: string[], present: Set<string>;
    if (type === 'IFCELEMENTQUANTITY' && (name === 'Qto_SlabBaseQuantities' || name === 'Qto_RoofBaseQuantities')) {
      slot = 5; owned = name === 'Qto_RoofBaseQuantities' ? ['NetArea'] : ['NetArea', 'NetVolume'];
      owned.push(...view.getEffectiveChanges(original).filter(change => change.kind === 'quantity'
        && change.deleted && change.setName === name && change.name !== undefined).map(change => change.name!));
      present = new Set(view.getQuantitiesForEntity(original, base => extractQuantitiesOnDemand(store, base))
        .filter(set => set.name === name).flatMap(set => set.quantities.map(q => q.name)));
    } else if (type === 'IFCPROPERTYSET' && (name === 'Pset_SlabCommon' || name === ROOF_FOOTPRINT_PSET)) {
      slot = 4; owned = name === 'Pset_SlabCommon' ? ['PitchAngle'] : ['Footprint', 'EdgeSlopes', 'Overhang', 'Thickness'];
      present = new Set(view.getForEntity(original, baseProperties)
        .filter(set => set.name === name).flatMap(set => set.properties.map(p => p.name)));
    } else return definition;
    const members = record.attributes[slot];
    if (!Array.isArray(members)) throw new Error('Unreadable roof measurement members');
    const kept = members.filter(member => {
      const id = refId(member), memberName = id === null ? null : reader.entity(id)?.attributes[0];
      return typeof memberName !== 'string' || !owned.includes(memberName) || present.has(memberName);
    });
    if (kept.length === members.length) return definition;
    if (!kept.length) return null;
    spend(kept.length + 1);
    const independent = kept.map(member => {
      const id = refId(member), child = id === null ? null : measurementRecord(id);
      if (!child) throw new Error('Unreadable roof measurement member');
      const kind = child.type.toUpperCase();
      if (kind === 'IFCCOMPLEXPROPERTY' || kind === 'IFCPHYSICALCOMPLEXQUANTITY') return member;
      return `#${editor.addEntity(child.type, [...child.attributes]).expressId}`;
    });
    const attributes = [...record.attributes]; attributes[0] = guid(); attributes[slot] = independent;
    return editor.addEntity(record.type, attributes).expressId;
  };
  const copyMeasurements = (original: number, id: number, quantitySet: string, propertySet: string) => {
    const quantities = view.getQuantitiesForEntity(original, base => extractQuantitiesOnDemand(store, base));
    const properties = view.getForEntity(original, baseProperties);
    const deletions = view.getEffectiveChanges(original).filter(change => change.kind === 'quantity'
      && change.deleted && change.setName === quantitySet && change.name !== undefined);
    spend(quantities.filter(set => set.name === quantitySet).reduce((sum, set) => sum + set.quantities.length, 0)
      + properties.filter(set => set.name === propertySet).reduce((sum, set) => sum + set.properties.length, 0) + deletions.length);
    for (const set of quantities.filter(set => set.name === quantitySet)) for (const q of set.quantities) {
      view.setQuantity(id, set.name, q.name, q.value, q.type, q.unit);
    }
    for (const change of deletions) view.deleteQuantity(id, quantitySet, change.name!);
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
        const copiedDefinition = association.relType.toUpperCase() === 'IFCRELDEFINESBYPROPERTIES'
          ? definitionForCopy(definition, original) : definition;
        if (copiedDefinition === null) continue;
        editor.addEntity(association.relType, [guid(), association.ownerHistoryId === null ? null : `#${association.ownerHistoryId}`,
          association.name, association.description, [`#${id}`], `#${copiedDefinition}`]);
      }
    }
    copyMeasurements(original, id, 'Qto_SlabBaseQuantities', 'Pset_SlabCommon');
  }
  const roof = reader.entity(target)!, ownerId = refId(roof.attributes[1]);
  editor.addEntity('IfcRelAssignsToProduct', [guid(), ownerId === null ? null : `#${ownerId}`,
    RELATION_NAME, null, [...copied.keys()].map(id => `#${id}`), null, `#${target}`]);
  copyMeasurements(source, target, 'Qto_RoofBaseQuantities', ROOF_FOOTPRINT_PSET);
  // The ordinary product copy already wrote the roof's saved associations.
  // Trim only owned missing members, retaining unrelated native definitions.
  for (const relation of reader.ids('IFCRELDEFINESBYPROPERTIES')) {
    if (!view.getNewEntity(relation)) continue;
    const a = reader.entity(relation)!.attributes, related = a[4], definition = refId(a[5]);
    if (!Array.isArray(related) || related.length !== 1 || refId(related[0]) !== target || definition === null) continue;
    const copiedDefinition = definitionForCopy(definition, source);
    if (copiedDefinition === null) editor.removeEntity(relation);
    else if (copiedDefinition !== definition) editor.setPositionalAttribute(relation, 5, `#${copiedDefinition}`);
  }
  return copied;
}
