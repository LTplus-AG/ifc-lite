/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The relation-borne chart field families (#4833): quantities
 * (`IfcElementQuantity`), material (`IfcRelAssociatesMaterial`),
 * classification (`IfcRelAssociatesClassification`), the defining type
 * (`IfcRelDefinesByType`) and the spatial container
 * (`IfcRelContainedInSpatialStructure` / `IfcRelAggregates`). All read
 * through the Lists data provider, so a chart and a list answer the same
 * value for the same element; quantities also honour the mutation overlay
 * and fall back to the defining type like properties do.
 */
import type { ElementFieldBinding } from '@ifc-lite/charts';
import { QuantityType, type Quantity, type QuantitySet } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { ListDataProvider } from '@ifc-lite/lists';
import { findQuantityInSets } from '@ifc-lite/query';
import type { ResolvedElementFieldValue } from './element-field-reader';
import { emptyObservation, type ElementFieldObservations } from './element-field-discovery';

/** The IFC measure a `QuantityType` is expressed in, so quantities ride the same unit resolution as typed properties. */
export const QUANTITY_MEASURE: Record<number, string> = {
  [QuantityType.Length]: 'IFCLENGTHMEASURE',
  [QuantityType.Area]: 'IFCAREAMEASURE',
  [QuantityType.Volume]: 'IFCVOLUMEMEASURE',
  [QuantityType.Weight]: 'IFCMASSMEASURE',
  [QuantityType.Time]: 'IFCTIMEMEASURE',
  [QuantityType.Count]: 'IFCCOUNTMEASURE',
  [QuantityType.Number]: 'IFCNUMERICMEASURE',
};

/** `quantity-collect` records an explicit `IfcPhysicalSimpleQuantity.Unit` as its SI scale; the shared `Quantity` type does not declare it. */
function explicitQuantityScale(quantity: Quantity): number | undefined {
  const scale = (quantity as { explicitUnitSiScale?: unknown }).explicitUnitSiScale;
  return typeof scale === 'number' && Number.isFinite(scale) ? scale : undefined;
}

const MISSING: ResolvedElementFieldValue = { value: null, status: 'missing' };

/** De-duplicated, order-preserving join — the Lists engine's multi-value cell. */
function uniqueJoin(values: readonly string[]): string | null {
  const distinct = [...new Set(values.filter((value) => value.length > 0))];
  return distinct.length > 0 ? distinct.join(', ') : null;
}

export interface ElementFamilyReader {
  read(expressId: number, binding: Exclude<ElementFieldBinding, { kind: 'attribute' | 'property' }>): ResolvedElementFieldValue;
  /** Record which families and quantities these elements expose. */
  observe(expressId: number, into: ElementFieldObservations): void;
}

export function createElementFamilyReader(
  provider: ListDataProvider,
  definingTypeId: (expressId: number) => number,
  mutationView?: MutablePropertyView,
): ElementFamilyReader {
  const occurrenceQsets = new Map<number, QuantitySet[]>();
  const typeQsets = new Map<number, QuantitySet[]>();

  /** Overlay sets win by name; base sets the overlay does not know about are kept. */
  const overlayFirst = (overlay: readonly QuantitySet[], base: readonly QuantitySet[]): QuantitySet[] => {
    const names = new Set(overlay.map((set) => set.name));
    return [...overlay, ...base.filter((set) => !names.has(set.name))];
  };
  const qsetsFor = (id: number): QuantitySet[] => {
    let cached = occurrenceQsets.get(id);
    if (!cached) {
      const base = provider.getQuantitySets(id);
      // A view built for a server-hydrated store has no quantity extractor and
      // answers from the overlay alone; without an edit on this element that
      // empty answer must not hide the provider's quantities (review find).
      const overlay = mutationView?.getQuantitiesForEntity(id);
      cached = !mutationView || !overlay ? base
        : overlay.length === 0 && !mutationView.hasChanges(id) ? base
          : overlay;
      occurrenceQsets.set(id, cached);
    }
    return cached;
  };
  const typeQsetsFor = (id: number): QuantitySet[] => {
    const typeId = definingTypeId(id);
    if (typeId < 0) return [];
    let cached = typeQsets.get(typeId);
    if (!cached) {
      // The overlay's extractor only knows occurrence-oriented sets, so the
      // type's own HasPropertySets quantities come from the provider; an edit
      // on the type object still wins by set name (review find).
      const base = provider.getTypeQuantitySets?.(id) ?? [];
      const overlay = mutationView?.hasChanges(typeId) ? mutationView.getQuantitiesForEntity(typeId) : [];
      cached = overlay.length > 0 ? overlayFirst(overlay, base) : base;
      typeQsets.set(typeId, cached);
    }
    return cached;
  };
  const quantityFor = (id: number, qsetName: string, quantityName: string): Quantity | undefined => {
    const occurrence = findQuantityInSets(qsetsFor(id), qsetName, quantityName);
    if (occurrence) return occurrence;
    // A quantity the overlay deleted from the occurrence stays missing: the
    // defining type's same-named quantity must not resurrect it (review find).
    if (mutationView?.hasChanges(id) && findQuantityInSets(provider.getQuantitySets(id), qsetName, quantityName)) return undefined;
    return findQuantityInSets(typeQsetsFor(id), qsetName, quantityName);
  };

  const classificationValue = (id: number, system: string | undefined): string | null => {
    const refs = provider.getClassifications?.(id) ?? [];
    return uniqueJoin(refs
      .filter((ref) => system === undefined || ref.system === system)
      .map((ref) => ref.code || ref.name || ''));
  };

  const spatialValue = (id: number, level: 'Container' | 'Building' | 'Site' | 'Project'): string | null => {
    switch (level) {
      case 'Container': return provider.getContainerName?.(id) || null;
      case 'Building': return provider.getBuildingName?.(id) || null;
      case 'Site': return provider.getSiteName?.(id) || null;
      case 'Project': return provider.getProjectName?.() || null;
    }
  };

  const text = (value: string | null): ResolvedElementFieldValue => (value === null ? MISSING : { value, status: 'value' });

  return {
    read(id, binding) {
      switch (binding.kind) {
        case 'quantity': {
          const quantity = quantityFor(id, binding.qsetName, binding.quantityName);
          if (!quantity || !Number.isFinite(quantity.value)) return MISSING;
          const dataType = QUANTITY_MEASURE[quantity.type];
          const scale = explicitQuantityScale(quantity);
          if (binding.valueKind !== 'number') return { value: String(quantity.value), status: 'value', ...(dataType ? { dataType } : {}) };
          return { value: quantity.value, status: 'value', ...(dataType ? { dataType } : {}), ...(scale !== undefined ? { unitSiScale: scale } : {}) };
        }
        case 'material': return text(uniqueJoin(provider.getMaterialNames?.(id) ?? []));
        case 'classification': return text(classificationValue(id, binding.system));
        case 'type': return text(provider.getEntityDefiningTypeName?.(id) || null);
        case 'spatial': return text(spatialValue(id, binding.level));
      }
    },

    observe(id, into) {
      const ingest = (sets: readonly QuantitySet[]): void => {
        for (const set of sets) for (const quantity of set.quantities) {
          if (!set.name || !quantity.name) continue;
          const key = JSON.stringify([set.name, quantity.name]);
          let entry = into.quantities.get(key);
          if (!entry) {
            entry = { qsetName: set.name, quantityName: quantity.name, kind: emptyObservation() };
            into.quantities.set(key, entry);
          }
          const dataType = QUANTITY_MEASURE[quantity.type];
          if (dataType) entry.kind.dataTypes.add(dataType);
          if (Number.isFinite(quantity.value)) entry.kind.number = true;
        }
      };
      ingest(qsetsFor(id));
      ingest(typeQsetsFor(id));

      const relations = into.relations;
      relations.material ||= (provider.getMaterialNames?.(id) ?? []).length > 0;
      relations.type ||= Boolean(provider.getEntityDefiningTypeName?.(id));
      for (const ref of provider.getClassifications?.(id) ?? []) {
        relations.classification = true;
        if (ref.system) relations.classificationSystems.add(ref.system);
      }
      for (const level of ['Container', 'Building', 'Site', 'Project'] as const) {
        if (spatialValue(id, level)) relations.spatial.add(level);
      }
    },
  };
}
