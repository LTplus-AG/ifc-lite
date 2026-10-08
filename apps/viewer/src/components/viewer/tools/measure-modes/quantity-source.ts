/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Native quantity source/unit adapters extracted without changing the engine (#7184).
import { extractQuantitiesOnDemand, extractTypeQuantitiesOnDemand, ProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';
import { QUANTITY_TYPE_UNIT } from '@/lib/units/display';
import { resolveFromUnit, convertValue } from '@/lib/units/convert';

/**
 * Build the file-unit -> SI converter for one store's declared units.
 *
 * Goes through `convertValue` rather than multiplying by `siScale` directly so
 * an affine unit would carry its offset. None of the four families here is
 * affine today, which is exactly why doing it by hand would look correct
 * forever and then not be.
 */
export function siConverterFor(units: ProjectUnits) {
  return (value: number, quantityType: number): number => {
    const entry = QUANTITY_TYPE_UNIT[quantityType];
    if (!entry) return value;
    const fileUnit = units.resolvedForUnitType(entry.unitType)
      ?? { symbol: entry.defaultSymbol, siScale: 1.0 };
    return convertValue(value, resolveFromUnit(entry.unitType, fileUnit), { scale: 1 });
  };
}

/**
 * Build the file-unit -> kg/m³ converter for a material's declared density.
 *
 * Routed through `unitForMeasure('IFCMASSDENSITYMEASURE')` — the same
 * `project_units` resolver the property cards already use for this measure —
 * rather than assuming kg/m³. A project declaring grams and millimetres writes
 * its `MassDensity` in g/mm³, and taking that number as kilograms per cubic
 * metre is wrong by a factor of a million.
 *
 * `unitForMeasure` already falls back to the measure's SI default, so the
 * common file that declares no `MASSDENSITYUNIT` converts by 1.
 */
export function densitySiConverterFor(units: ProjectUnits) {
  const fileUnit = units.unitForMeasure('IFCMASSDENSITYMEASURE')
    ?? { symbol: 'kg/m³', siScale: 1.0 };
  const from = resolveFromUnit('MASSDENSITYUNIT', fileUnit);
  return (value: number): number => convertValue(value, from, { scale: 1 });
}

/**
 * Occurrence quantities win, with the element's type as fallback (#1755).
 *
 * "Win" requires at least one ACTUAL quantity: a named-but-empty occurrence
 * quantity set must not mask populated type-level ones. Type extraction is
 * cached per type, so a 500-door type is parsed once rather than 500 times.
 *
 * Both parse paths are served, mirroring the Lists adapter's split (#1751):
 * `extractTypeQuantitiesOnDemand` walks the STEP source and returns `null`
 * outright when there is none, which is every server-parsed store — those
 * carry the type's own quantity sets in the prebuilt table instead, keyed by
 * the TYPE's express id. Taking only the source-backed branch would drop
 * type-declared volumes on the server path while the occurrence branch (whose
 * extractor already falls back to that same table) kept working, so the loss
 * would look like a file that simply declares nothing.
 */
export function quantitySetsFor(
  store: IfcDataStore,
  expressId: number,
  typeCache: Map<number, ReturnType<typeof extractQuantitiesOnDemand>>,
) {
  const typeQsets = () => {
    if (!store.relationships) return [];
    const typeIds = store.relationships.getRelated(expressId, RelationshipType.DefinesByType, 'inverse');
    if (typeIds.length === 0) return [];
    const typeId = typeIds[0];
    let cached = typeCache.get(typeId);
    if (!cached) {
      cached = store.source?.length
        ? (extractTypeQuantitiesOnDemand(store, expressId)?.quantities ?? [])
        : (store.quantities?.getForEntity(typeId) ?? []);
      typeCache.set(typeId, cached);
    }
    return cached;
  };

  const own = extractQuantitiesOnDemand(store, expressId);
  return own.some((qset) => qset.quantities.length > 0) ? own : typeQsets();
}

