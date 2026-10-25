/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two per-slot serialize helpers `step-attribute-mutations.ts`'s
 * source-buffer pipeline and `step-overlay-attribute-overrides.ts`'s
 * overlay-created pipeline both go through — the single point where a named
 * or positional override becomes a STEP token. Split out of
 * `step-attribute-mutations.ts` (#3184).
 */

import type { IfcAttributeValue } from '@ifc-lite/parser';
import { getEnumTypedSlots, getStringTypedSlots, serializeEnumToken, serializeStringSlot } from './attribute-slot-types.js';
import { isTypedMarker } from './attribute-real-slots.js';
import { serializeQualifiedSelectSlot } from './select-qualification.js';
import {
  toStepReal,
  serializeAttributeValue,
  serializeStepValue,
  tokenIsRealLiteral,
} from './step-serialization.js';
import type { IfcSchemaVersion } from './schema-converter.js';

/**
 * Serialize one NAMED attribute override into its slot — the single point
 * both the source-buffer rewrite and the overlay-created rewrite go through.
 *
 * `serializeAttributeValue` decides the STEP form by reading the token being
 * replaced, which is sound only while that token carries type information. A
 * `$` slot carries none, and both paths have plenty: a source record's
 * optional attributes are `$`, and overlay-created records pad missing slots
 * with `$`. So the declared type decides first, and inference is the fallback
 * for slots the schema does not classify (references, SELECTs, numerics),
 * where reading the old token is exactly the right heuristic.
 *
 * Before this REAL check existed, "the declared type decides first" was true
 * for enum/string slots only — a REAL-backed slot (`IfcMapConversion.
 * OrthogonalHeight`, any other `IfcLengthMeasure`/`IfcReal`-typed attribute)
 * fell straight to `serializeAttributeValue`'s token inference, which quotes
 * anything it cannot recognize as numeric. A schema-legal `$` placeholder
 * carries no digits to recognize, so setting such a field for the first time
 * wrote `'12345'` in a slot ISO 10303-21 requires to be an unquoted REAL —
 * silently invalid output (#2724, LTplus-AG/ifc-lite#2475).
 */
export function serializeNamedAttribute(
  entityType: string,
  index: number,
  value: string,
  currentToken: string,
  realSlots: ReadonlySet<number>,
): string | null {
  if (getEnumTypedSlots(entityType).has(index)) return serializeEnumToken(value);
  if (getStringTypedSlots(entityType).has(index)) return serializeStringSlot(value);
  if (realSlots.has(index)) {
    const trimmed = value.trim();
    if (trimmed === '') return '$';
    const numberValue = Number(trimmed);
    if (Number.isFinite(numberValue)) return toStepReal(numberValue);
    // A non-numeric value in a REAL slot used to fall through and be QUOTED,
    // producing the same ISO 10303-21 violation #2725 exists to prevent
    // (#2741). `StoreEditor.setAttribute` takes a string, so any UI text
    // field bound to a georeferencing REAL can deliver one; it does not need
    // a corrupt file.
    //
    // `null` means "leave the slot as the file had it". Simply returning
    // `currentToken` here would stop the invalid output but SILENTLY DISCARD
    // the edit - the exporter would then claim a modification it did not
    // carry, which is the exact misreport #2723/#2724/#2726 were written to
    // pin. The caller turns this into a warning, so a dropped edit is visible
    // rather than inferred from absence.
    return null;
  }
  return serializeAttributeValue(value, currentToken);
}

/**
 * Serialize one positional override, composing the schema-aware passes:
 * explicit `{ real }`/`{ typed }` marker → SELECT auto-qualification
 * (`IFCBOOLEAN(.T.)`) → REAL forcing. For REAL forcing the current source
 * token is a secondary signal: replacing a value that was already a REAL
 * (`0.4`, `1.5E-7`) keeps it REAL even for entities the XSD index doesn't
 * cover, so a whole-number edit can't silently downgrade the slot.
 */
export function serializePositionalOverride(
  entityType: string,
  index: number,
  value: IfcAttributeValue,
  currentToken: string,
  realSlots: ReadonlySet<number>,
  schemaVersion: IfcSchemaVersion,
): string {
  if (isTypedMarker(value)) return serializeStepValue(value);
  const qualified = serializeQualifiedSelectSlot(entityType, index, value);
  if (qualified !== null) return qualified;
  const forceReal = realSlots.has(index) || tokenIsRealLiteral(currentToken);
  return serializeStepValue(value, forceReal);
}
