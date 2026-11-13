/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue, StoreEditor } from '@ifc-lite/mutations';
import { getFootprintRoofPlaneParts } from './roof-plane-parts.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';
import { ROOF_FOOTPRINT_PSET } from './roof-footprint.js';
import { readFileRecord, type FileRecord } from './step-record-attrs.js';

const writesByEditor = new WeakMap<StoreEditor, number>();
const MAX_MEASUREMENT_COPY_WRITES = 10_000;

/** The ordinary assembly copy carries geometry and placements. Merge saved and
 * live measurements onto those copied products, retaining explicit deletions. */
export function copyRoofPlaneParts(store: IfcDataStore, editor: StoreEditor, source: number, target: number,
  copiedFrom: ReadonlyMap<number, number>, random?: RandomSource): void {
  const view = editor.getMutationView(), parts = getFootprintRoofPlaneParts(store, view, source);
  if (!parts.length) return;
  if (parts.length > 10_000) throw new Error('Roof plane copy exceeds 10000 parts');
  if (!store.source) throw new Error('Roof plane copy requires source bytes');
  const spend = (writes: number) => {
    const total = (writesByEditor.get(editor) ?? 0) + writes;
    if (total > MAX_MEASUREMENT_COPY_WRITES) throw new Error('Roof measurement copy exceeds 10000 writes in one operation');
    writesByEditor.set(editor, total);
  };
  spend(parts.length + 1);
  const reader = new AnchorEntityReader(store, view);
  const copied = new Map([...copiedFrom].filter(([, original]) => parts.includes(original)));
  if (copied.size !== parts.length) throw new Error('Roof assembly copy omitted a plane');
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
    const attributes = [...record.attributes]; attributes[0] = generateIfcGuid(random); attributes[slot] = independent;
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
  for (const [id, original] of copied) copyMeasurements(original, id, 'Qto_SlabBaseQuantities', 'Pset_SlabCommon');
  copyMeasurements(source, target, 'Qto_RoofBaseQuantities', ROOF_FOOTPRINT_PSET);
  // The assembly copy already wrote saved associations for the roof and planes.
  // Trim only missing members, retaining unrelated native definitions.
  copied.set(target, source);
  for (const relation of reader.ids('IFCRELDEFINESBYPROPERTIES')) {
    if (!view.getNewEntity(relation)) continue;
    const a = reader.entity(relation)!.attributes, related = a[4], definition = refId(a[5]);
    const product = Array.isArray(related) && related.length === 1 ? refId(related[0]) : null;
    const original = product === null ? undefined : copied.get(product);
    if (original === undefined || definition === null) continue;
    const copiedDefinition = definitionForCopy(definition, original);
    if (copiedDefinition === null) editor.removeEntity(relation);
    else if (copiedDefinition !== definition) editor.setPositionalAttribute(relation, 5, `#${copiedDefinition}`);
  }
}
