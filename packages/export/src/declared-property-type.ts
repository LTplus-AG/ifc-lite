/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The declared type a REGENERATED property is written back with
 * (github.com/LTplus-AG/ifc-lite/issues/2482).
 *
 * Editing one property in a property set regenerates the WHOLE set, so every
 * other property in it is re-serialized too. Those neighbours were written from
 * `PropertyValueType` alone, which is a shape (string / real / integer / …) and
 * not a type: the extractor collapses `IFCLABEL`, `IFCTEXT` and `IFCIDENTIFIER`
 * to `String`, and every `…MEASURE` / `…RATIO` to `Real`, keeping the source
 * token only in `Property.dataType`. Regenerating from the shape therefore
 * rewrote `IFCTEXT` as `IFCLABEL` and `IFCLENGTHMEASURE` as `IFCREAL` — silently,
 * permanently, and for properties the user never touched. On the numeric side
 * the measure token IS the unit semantics, so the loss is not cosmetic.
 *
 * `dataType` is whatever token the source line carried, so it is NOT written
 * back unconditionally. Three gates, in order:
 *
 * 1. **It must name a member of `IfcValue`.** `NominalValue` is declared as
 *    `IfcValue`, so a token outside that SELECT is not writable there —
 *    including the vendor and non-conformant tokens a source file can carry
 *    (`IFCACMEWIDGETCODE('X')` parses fine and round-trips through `dataType`).
 *    Membership is resolved from the schema registry rather than a hand-written
 *    list, so all 106 of IFC4's `IfcValue` leaves are covered and nothing else
 *    is. An unrecognized token falls back to the shape-derived primitive — the
 *    old behaviour, which is lossy but valid, rather than a token no consumer
 *    can resolve.
 *
 * 2. **Its EXPRESS base must agree with the effective `PropertyValueType`.**
 *    This is what decides the OTHER question #2482 raised: what wins when the
 *    session edited the value. `setProperty(…, valueType)` writes the effective
 *    type; `dataType` stays the SOURCE token. When the caller names a type in a
 *    different family (a `Boolean` written over an `IFCLENGTHMEASURE`), the
 *    caller wins and the source token is dropped. When the two agree — which is
 *    always the case for a property nobody edited, since the extractor derived
 *    both from the same token — the source token is the more specific of the
 *    two and wins.
 *
 * 3. **The VALUE must be representable in that base.** `serializeTypedMarker`
 *    coerces, so without this an `IFCLENGTHMEASURE` carrying a non-numeric
 *    value would be written as `IFCLENGTHMEASURE(NaN)`, where the shape-derived
 *    path writes `$`. This gate also excludes the multi-valued property kinds
 *    for free: an `IfcPropertyBoundedValue` is extracted as a measure `dataType`
 *    over a DISPLAY STRING (`'12.5 [1 – 20]'`), and a string does not fit a REAL
 *    base. Those kinds are regenerated as single values today — lossy, and a
 *    separate question — but this pass must not make them worse by wrapping a
 *    display string in a measure token.
 *
 * A `null` value is left entirely to {@link serializePropertyValue}: null is
 * the extractor's reading of `IFCLOGICAL(.U.)` as well as of an absent value,
 * and which of those a null means is #2472's question, not this one.
 */

import { PropertyValueType } from '@ifc-lite/data';
import { getSelectDefinedLeaves } from './select-qualification.js';
import { serializePropertyValue, serializeTypedMarker } from './step-serialization.js';

/** The SELECT `IfcPropertySingleValue.NominalValue` is declared as. */
const NOMINAL_VALUE_SELECT = 'IfcValue';

/** UPPERCASE STEP token → `[schema-cased type name, EXPRESS base]`. */
let nominalValueLeaves: Map<string, readonly [string, string]> | null = null;

function lookupNominalValueLeaf(token: string): readonly [string, string] | undefined {
  if (!nominalValueLeaves) {
    nominalValueLeaves = new Map();
    for (const [type, base] of getSelectDefinedLeaves(NOMINAL_VALUE_SELECT)) {
      nominalValueLeaves.set(type.toUpperCase(), [type, base]);
    }
  }
  return nominalValueLeaves.get(token);
}

/**
 * The EXPRESS bases a property of `type` may be re-declared as. `null` for the
 * kinds that are not a single scalar `IfcValue` at all — an `Enum` is a bare
 * enumeration token, a `Reference` is a different property CLASS, and a `List`
 * is an aggregate.
 */
function acceptedBases(type: PropertyValueType): readonly string[] | null {
  switch (type) {
    case PropertyValueType.String:
    case PropertyValueType.Label:
    case PropertyValueType.Text:
    case PropertyValueType.Identifier:
      return ['STRING'];
    case PropertyValueType.Real:
      // NUMBER as well as REAL: several IfcValue members (IfcCountMeasure,
      // IfcNumericMeasure) bottom out in NUMBER and are read back as numbers.
      return ['REAL', 'NUMBER'];
    case PropertyValueType.Integer:
      return ['INTEGER', 'NUMBER'];
    case PropertyValueType.Boolean:
      return ['BOOLEAN'];
    case PropertyValueType.Logical:
      return ['LOGICAL'];
    default:
      return null;
  }
}

/** Whether `value` can be written into `base` without being coerced into
 *  something the shape-derived path would have refused to write at all. */
function valueFitsBase(value: unknown, base: string): value is string | number | boolean {
  switch (base) {
    case 'STRING':
      return typeof value === 'string';
    case 'REAL':
    case 'NUMBER':
      return typeof value === 'number' && Number.isFinite(value);
    case 'INTEGER':
      return typeof value === 'number' && Number.isInteger(value);
    case 'BOOLEAN':
    case 'LOGICAL':
      // Not a truthiness test: `serializeTypedMarker` reads `'.F.'` and
      // `'maybe'` alike, and the shape-derived path answers `IFCLOGICAL(.U.)`
      // for anything that is not a real boolean. Leave those to it.
      return typeof value === 'boolean';
    default:
      // BINARY and anything the registry resolves to something else: the
      // extractor has no path that produces a faithful JS value for these.
      return false;
  }
}

/**
 * The schema-cased `IfcValue` member `dataType` names, when it is safe to write
 * a regenerated property back with it, else `null`. See the module docstring
 * for the three gates.
 */
export function declaredNominalValueType(
  value: unknown,
  type: PropertyValueType,
  dataType: string | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (!dataType) return null;
  const leaf = lookupNominalValueLeaf(dataType.trim().toUpperCase());
  if (!leaf) return null;
  const [name, base] = leaf;
  const accepted = acceptedBases(type);
  if (!accepted || !accepted.includes(base)) return null;
  if (!valueFitsBase(value, base)) return null;
  return name;
}

/**
 * Serialize a property's `NominalValue`, honouring the type the SOURCE line
 * declared when the property carries one and it survives the gates above.
 * Falls back to {@link serializePropertyValue}, which derives the primitive
 * from the property's shape alone.
 */
export function serializeNominalValue(
  value: unknown,
  type: PropertyValueType,
  dataType: string | undefined,
): string {
  const declared = declaredNominalValueType(value, type, dataType);
  if (declared === null) return serializePropertyValue(value, type);
  return serializeTypedMarker(declared, value as string | number | boolean);
}
