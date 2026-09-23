/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from './columnar-parser.js';
import type { EntityExtractor } from './entity-extractor.js';
import { measureUnit, resolveUnitByRef } from './project-units.js';

/**
 * The explicit `Unit` an `IfcProperty` subtype declares, when it declares one.
 *
 * `siScale` is present only when the unit entity resolved (its symbol and
 * scale to the SI base are known). A `Unit` reference the file does not let us
 * read — a dangling ref, an `IfcSIUnit` name outside the table, a conversion
 * factor that cannot be followed — is still REPORTED, as the STEP reference
 * (`#123`, the same spelling `IfcPropertyReferenceValue` uses) with no scale:
 * the value is in a unit we cannot name, which is a different fact from "the
 * value is in the project unit". Readers that aggregate must treat a missing
 * `siScale` as not convertible rather than falling back to the project
 * assignment (#4833).
 */
export interface ExplicitPropertyUnit {
  symbol: string;
  siScale?: number;
}

/** Resolve the optional explicit Unit attribute shared by IFC property values. */
export function resolvePropertyUnit(
  store: IfcDataStore,
  extractor: EntityExtractor,
  propertyType: string,
  attributes: unknown[],
  /** The value's IFC measure type when tagged; an explicit unit of another dimension is reported unresolved. */
  dataType?: string,
): ExplicitPropertyUnit | undefined {
  // IfcPropertyTableValue carries DefiningUnit and DefinedUnit (slots 5 and
  // 6); a single `unit` cannot represent both, so a table reports none.
  const type = propertyType.toUpperCase();
  const unitIndex = type === 'IFCPROPERTYBOUNDEDVALUE' ? 4
    : type === 'IFCPROPERTYSINGLEVALUE' || type === 'IFCPROPERTYLISTVALUE' ? 3 : -1;
  const unitRef = unitIndex >= 0 && typeof attributes[unitIndex] === 'number'
    ? attributes[unitIndex]
    : undefined;
  if (unitRef === undefined) return undefined;

  // @raw-entity-enumeration-ok unit resolver follows this property's explicit source unit reference
  const entry = resolveUnitByRef(extractor, {
    byId: { get: (id) => store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id) },
  }, unitRef);
  const measure = dataType ? measureUnit(dataType) : undefined;
  const compatible = !entry || !measure
    || (measure.kind === 'typed' && entry.unitType === measure.unitType)
    || (measure.kind === 'monetary' && entry.monetary)
    || measure.kind === 'dimensionless';
  return entry && compatible ? { symbol: entry.resolved.symbol, siScale: entry.resolved.siScale } : { symbol: `#${unitRef}` };
}
