/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-aware detection of REAL-typed STEP attribute slots.
 *
 * ISO 10303-21 requires a REAL-typed attribute (`IfcLengthMeasure` and every
 * other `<real>`-backed defined type) to carry a decimal point — `450.`, never
 * `450`. A bare JavaScript number is ambiguous at the value level (it could be
 * an `IfcInteger`), so `serializeStepValue` defaults to emitting whole numbers
 * as STEP INTEGER literals. That default silently produces strict-invalid files
 * whenever a whole number lands in a REAL slot — the natural
 * `setPositionalAttribute(profId, 3, 450)` call, `addEntity` args, and the
 * geometry the in-store builders emit themselves (millimetre models round to
 * whole numbers, making this the common case). See LTplus-AG/ifc-lite#1839.
 *
 * The slot's declared type is statically known from the schema registry, so we
 * resolve it once per (entity, version) and force a REAL literal on those slots
 * at serialization time — no caller change, no `{ real }` marker required.
 */

import type { IfcAttributeValue } from '@ifc-lite/parser';
import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';
import { getAttributeXsdTypes, type IfcSchemaVersion as DataSchemaVersion } from '@ifc-lite/data';
import type { IfcSchemaVersion } from './schema-converter.js';
import { serializeStepValue } from './step-serialization.js';

/**
 * Map the exporter's schema tag to the version the attribute XSD index is keyed
 * by. `IFC4X3_ADD2` is not an exporter tag; `IFC5` has no bundled XSD table.
 * REAL-vs-INTEGER of a geometry slot is version-invariant, so any unmapped tag
 * falls back to IFC4 — a slot missing from that version simply won't be forced.
 */
function toDataSchemaVersion(v: IfcSchemaVersion): DataSchemaVersion {
  switch (v) {
    case 'IFC2X3':
      return 'IFC2X3';
    case 'IFC4X3':
      return 'IFC4X3';
    case 'IFC4':
      return 'IFC4';
    default:
      return 'IFC4';
  }
}

// Memoized `version|ENTITY` → set of positional slot indices that are
// unambiguously REAL-backed. Keyed by upper-case type so `IfcColumn`/`IFCCOLUMN`
// collapse to one entry.
const realSlotCache = new Map<string, Set<number>>();

/**
 * The set of zero-based positional attribute indices on `entityType` whose
 * declared type is unambiguously REAL-backed (`xs:double`, and NOT also
 * `xs:integer`). An index that also admits an integer — a genuine
 * `SELECT(IfcInteger, IfcReal)` — stays out of the set: it is truly ambiguous,
 * and the explicit `{ real }` marker is the caller's way to disambiguate it.
 *
 * Returns an empty set for entities the registry does not know (vendor
 * extensions, unmapped schema), preserving the historical default there.
 */
export function getRealTypedSlots(entityType: string, version: IfcSchemaVersion): Set<number> {
  const dataVersion = toDataSchemaVersion(version);
  const upperType = entityType.toUpperCase();
  const key = `${dataVersion}|${upperType}`;
  const cached = realSlotCache.get(key);
  if (cached) return cached;

  // Resolve positional names across the bundled schema union (2X3 + 4 + 4X3),
  // not just the parser's IFC4-pinned registry — otherwise IFC4X3-only leaves
  // (IfcAlignmentHorizontalSegment and the civil/alignment geometry this fix
  // targets) return no names, and their REAL slots (StartDirection,
  // SegmentLength, …) would still emit bare INTEGER literals.
  const names = getAttributeNamesAcrossSchemas(entityType);
  const slots = new Set<number>();
  for (let i = 0; i < names.length; i++) {
    const xsd = getAttributeXsdTypes(dataVersion, upperType, names[i]);
    if (xsd && xsd.includes('xs:double') && !xsd.includes('xs:integer')) {
      slots.add(i);
    }
  }
  realSlotCache.set(key, slots);
  return slots;
}

/**
 * Serialize a full positional attribute list for an entity to a STEP body,
 * forcing a REAL literal (decimal point) on every unambiguously double-backed
 * slot. Used for freshly-emitted overlay entities (`addEntity`, the in-store
 * builders) whose numbers never pass through a source token.
 */
export function serializeEntityArgs(
  entityType: string,
  values: readonly IfcAttributeValue[],
  version: IfcSchemaVersion,
): string {
  const realSlots = getRealTypedSlots(entityType, version);
  return values.map((value, i) => serializeStepValue(value, realSlots.has(i))).join(',');
}
