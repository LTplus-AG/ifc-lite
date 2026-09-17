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

/** A resolved quantity and where it came from, so its explicit scale is looked up on the right entity. */
interface FoundQuantity {
  quantity: Quantity;
  fromType: boolean;
}

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

  /**
   * Merge an overlay that has NO quantity base (a view over a server-hydrated
   * store answers from its own edits alone) over the provider's sets: a set
   * the overlay knows keeps the overlay's members and gains the base members
   * it does not name, so editing Qto_X.A never hides Qto_X.B or Qto_Y. A view
   * WITH a base already applies edits and deletions to the full list and is
   * taken as is.
   */
  const overlayFirst = (overlay: readonly QuantitySet[], base: readonly QuantitySet[]): QuantitySet[] => {
    const byName = new Map(overlay.map((set) => [set.name, set]));
    const merged: QuantitySet[] = overlay.map((set) => {
      const named = new Set(set.quantities.map((quantity) => quantity.name));
      const inherited: Quantity[] = [];
      // Two base instances may share a name (a type set and an occurrence set); every one contributes.
      for (const baseSet of base) if (baseSet.name === set.name) for (const quantity of baseSet.quantities) if (!named.has(quantity.name)) { named.add(quantity.name); inherited.push(quantity); }
      return inherited.length > 0 ? { ...set, quantities: [...set.quantities, ...inherited] } : set;
    });
    return [...merged, ...base.filter((set) => !byName.has(set.name))];
  };
  const qsetsFor = (id: number): QuantitySet[] => {
    let cached = occurrenceQsets.get(id);
    if (!cached) {
      const base = provider.getQuantitySets(id);
      // A view built for a server-hydrated store has no quantity extractor and
      // answers from the overlay alone, so the overlay is merged over the
      // provider's sets (minus the ones it deleted) rather than replacing
      // them: editing Qto_X.A must not make Qto_X.B or Qto_Y vanish
      // (review find). A view with an extractor already includes the base, and
      // the merge dedupes by set name.
      cached = !mutationView ? base
        : mutationView.hasQuantityBase() ? mutationView.getQuantitiesForEntity(id)
          : overlayFirst(mutationView.getQuantitiesForEntity(id), base.filter((set) => !mutationView.isQuantitySetDeleted(id, set.name)));
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
      const base = (provider.getTypeQuantitySets?.(id) ?? []).filter((set) => !mutationView?.isQuantitySetDeleted(typeId, set.name));
      const overlay = mutationView?.hasChanges(typeId) ? mutationView.getQuantitiesForEntity(typeId) : [];
      cached = overlay.length > 0 ? overlayFirst(overlay, base) : base;
      typeQsets.set(typeId, cached);
    }
    return cached;
  };
  /**
   * The explicit-unit scale of a quantity. The overlay rebuilds an edited
   * quantity without the collector's `explicitUnitSiScale`, so when the edit
   * did not name a unit of its own the base quantity's scale still applies.
   */
  const explicitScaleFor = (id: number, found: FoundQuantity, qsetName: string): number | undefined => {
    const own = explicitQuantityScale(found.quantity);
    const owner = found.fromType ? definingTypeId(id) : id;
    if (own !== undefined || found.quantity.unit || !mutationView?.hasChanges(owner)) return own;
    const baseSets = found.fromType ? provider.getTypeQuantitySets?.(id) ?? [] : provider.getQuantitySets(id);
    const base = findQuantityInSets(baseSets, qsetName, found.quantity.name);
    return base ? explicitQuantityScale(base) : undefined;
  };
  const quantityFor = (id: number, qsetName: string, quantityName: string): FoundQuantity | undefined => {
    const occurrence = findQuantityInSets(qsetsFor(id), qsetName, quantityName);
    if (occurrence) return { quantity: occurrence, fromType: false };
    // A quantity the overlay deleted from the occurrence stays missing: the
    // defining type's same-named quantity must not resurrect it (review find).
    if (mutationView?.hasChanges(id) && findQuantityInSets(provider.getQuantitySets(id), qsetName, quantityName)) return undefined;
    const inherited = findQuantityInSets(typeQsetsFor(id), qsetName, quantityName);
    return inherited ? { quantity: inherited, fromType: true } : undefined;
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
      // A number is never a boolean, and a name is never a number: a binding
      // whose persisted kind the family cannot honour reads unsupported rather
      // than storing text in a numeric or boolean column (review find).
      if (binding.kind !== 'quantity' && binding.valueKind !== 'category') return { value: null, status: 'unsupported' };
      switch (binding.kind) {
        case 'quantity': {
          if (binding.valueKind === 'boolean') return { value: null, status: 'unsupported' };
          const found = quantityFor(id, binding.qsetName, binding.quantityName);
          if (!found || !Number.isFinite(found.quantity.value)) return MISSING;
          const { quantity } = found;
          const dataType = QUANTITY_MEASURE[quantity.type];
          const scale = explicitScaleFor(id, found, binding.qsetName);
          const provenance = {
            ...(dataType ? { dataType } : {}),
            // An edit that named its own unit arrives as a symbol; the dataset resolves it like a property's.
            ...(quantity.unit ? { unit: quantity.unit } : {}),
            ...(scale !== undefined ? { unitSiScale: scale } : {}),
          };
          if (binding.valueKind !== 'number') return { value: String(quantity.value), status: 'value', ...provenance };
          return { value: quantity.value, status: 'value', ...provenance };
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
      const occurrenceSets = qsetsFor(id);
      ingest(occurrenceSets);
      // A type quantity the occurrence overrides never reaches `read`; its measure must not shape the field (review find).
      const overridden = new Set(occurrenceSets.flatMap((set) => set.quantities.map((quantity) => JSON.stringify([set.name, quantity.name]))));
      ingest(typeQsetsFor(id).map((set) => ({ ...set, quantities: set.quantities.filter((quantity) => !overridden.has(JSON.stringify([set.name, quantity.name]))) })));

      const relations = into.relations;
      relations.material ||= (provider.getMaterialNames?.(id) ?? []).length > 0;
      relations.type ||= Boolean(provider.getEntityDefiningTypeName?.(id));
      // Only a DISPLAYABLE reference (a code or a name) counts as an observed
      // value; an association whose reference could not be read is not one.
      for (const ref of provider.getClassifications?.(id) ?? []) {
        if (!(ref.code || ref.name)) continue;
        relations.classification = true;
        if (ref.system) relations.classificationSystems.add(ref.system);
      }
      for (const level of ['Container', 'Building', 'Site', 'Project'] as const) {
        if (spatialValue(id, level)) relations.spatial.add(level);
      }
    },
  };
}
