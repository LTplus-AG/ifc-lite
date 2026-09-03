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
 * back unconditionally. Four gates, in order:
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
 *    **Unless the caller NAMED a member** ({@link NAMED_MEMBERS}, #3715). Gate 2
 *    as written could not express `IfcLabel` → `IfcText`: both are STRING, so
 *    "the two agree" and the source token won, silently discarding the request.
 *    The information it was missing is whether the caller CHOSE the type or
 *    merely echoed the shape the extractor derived — and that is already in the
 *    `PropertyValueType`, because the two are different members of it.
 *    `String` / `Real` are SHAPES, which is all the extractor can produce (it
 *    collapses `IFCLABEL`, `IFCTEXT` and `IFCIDENTIFIER` to `String` and keeps
 *    the token only in `dataType`); `Label` / `Identifier` / `Text` NAME one
 *    `IfcValue` member each and no extraction path produces them, so one of
 *    those can only have come from a caller who asked for it. A named member is
 *    therefore authoritative over the source token; a shape keeps gate 2's
 *    precedence, which is what stops a value-only edit — the UI passes `String`
 *    — from rewriting a neighbouring `IFCTEXT` as `IFCLABEL` all over again.
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
 * 4. **The VALUE must satisfy the member's own EXPRESS domain.** The base is not
 *    the whole type: eight `IfcValue` members are CONSTRAINED defined types whose
 *    WHERE rule narrows the primitive they resolve to. `-1` is a fine REAL and
 *    not a fine `IfcPositiveLengthMeasure`; `2` is a fine REAL and not a fine
 *    `IfcNormalisedRatioMeasure`. Since `setProperty` performs no schema
 *    validation, gate 3 alone let a session edit `IFCPOSITIVELENGTHMEASURE(5.)`
 *    to `-1` and re-declare it `IFCPOSITIVELENGTHMEASURE(-1.)` — a line that
 *    parses and fails validation, where the pre-#2482 shape-derived path wrote
 *    a valid `IFCREAL(-1.)`. A gate whose purpose is to stop the exporter
 *    writing a type it cannot justify must not itself write one.
 *
 *    A violating value RELAXES, where it can, to the nearest ancestor that is
 *    itself an `IfcValue` member over the same base and carries no constraint —
 *    `IfcPositiveLengthMeasure` → `IfcLengthMeasure` — resolved from the
 *    registry's alias chain, not listed. `IFCLENGTHMEASURE(-1.)` is schema-valid
 *    AND keeps the unit semantics, which is the whole thing #2482 is about;
 *    dropping to `IFCREAL(-1.)` would re-inflict this PR's own defect on exactly
 *    the properties whose value went out of range.
 *
 *    Two members have no such ancestor: `IfcPHMeasure` and
 *    `IfcHeatingValueMeasure` are declared directly as `REAL`, so their alias
 *    chain leaves `IfcValue` in one step. For those the relaxation returns
 *    `null` and the shape-derived `IFCREAL` is the answer — schema-valid, and
 *    the only valid one available. The relaxation target of every constrained
 *    member is named in `declared-nominal-value-type.test.ts`, so which of the
 *    two outcomes each takes is asserted rather than assumed.
 *
 *    **Where the constraints come from.** `SCHEMA_REGISTRY.types` is a
 *    `name -> underlying type` alias map (plus STRING widths); the generator
 *    does not carry WHERE rules, so there is nothing to read. The eight are
 *    therefore written out below, which is tolerable only because the set is
 *    CLOSED and small: they are every constrained member of `IfcValue`'s
 *    defined-type leaves, and a test derives that set from the bundled
 *    `packages/codegen/schemas/*.exp` — the WHERE rules themselves — to fail if
 *    a schema bump adds one this table has not heard of. That test used to ask
 *    the question by NAME (`/Positive|NonNegative|Normalised/`), which is how
 *    `IfcPHMeasure` and `IfcHeatingValueMeasure` sat outside the table for as
 *    long as they did (#3268). String widths, which the
 *    registry DOES carry (`IfcLabel: 'STRING(255)'`), are deliberately not
 *    gated: every fallback for a string shape is itself `IFCLABEL` /
 *    `IFCIDENTIFIER`, so rejecting an over-long label would emit the identical
 *    over-long line, and rejecting an over-long `IfcText` (unbounded, therefore
 *    valid) would narrow it to a bounded type and make the file worse.
 *
 * A `null` value is left entirely to {@link serializePropertyValue}: null is
 * the extractor's reading of `IFCLOGICAL(.U.)` as well as of an absent value,
 * and which of those a null means is #2472's question, not this one.
 */

import { PropertyValueType } from '@ifc-lite/data';
import { SCHEMA_REGISTRY } from '@ifc-lite/parser';
import { getSelectDefinedLeaves } from './select-qualification.js';
import { serializeTypedMarker } from './step-serialization.js';
import { serializePropertyValue } from './property-value-serialization.js';

/** The SELECT `IfcPropertySingleValue.NominalValue` is declared as. */
const NOMINAL_VALUE_SELECT = 'IfcValue';

/**
 * The `IfcValue` member each `PropertyValueType` NAMES OUTRIGHT — as opposed to
 * the shapes (`String`, `Real`, `Integer`, …) an extractor collapses a source
 * token into. See gate 2 in the module docstring: this map is what lets a caller
 * change a property's declared type WITHIN one EXPRESS base (#3715), which the
 * base-agreement rule alone made unexpressible.
 *
 * Only the string family appears, and that is not an omission: these three are
 * the only `PropertyValueType` members that name exactly one `IfcValue` member.
 * There is deliberately no entry for `Real` or `Integer` — `IfcLengthMeasure`,
 * `IfcReal` and every other numeric leaf all collapse to `Real`, so it names
 * nothing and must keep gate 2's "source token wins", which is #2482's whole
 * point. `Enum`, `Reference` and `List` are property CLASSES rather than
 * `NominalValue` tokens and are handled by {@link serializePropertyValue}.
 */
const NAMED_MEMBERS: ReadonlyMap<PropertyValueType, string> = new Map([
  [PropertyValueType.Label, 'IfcLabel'],
  [PropertyValueType.Identifier, 'IfcIdentifier'],
  [PropertyValueType.Text, 'IfcText'],
]);

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
 * The EXPRESS WHERE rule of every CONSTRAINED `IfcValue` member, keyed by the
 * registry's casing. Hand-written because `SCHEMA_REGISTRY` carries alias chains
 * and STRING widths but no WHERE rules — see gate 4 in the module docstring for
 * why a closed table is acceptable here and what keeps it honest.
 *
 * IFC4 ADD2 TC1, IfcMeasureResource.
 */
const CONSTRAINED_MEMBERS: ReadonlyMap<string, (value: number) => boolean> = new Map([
  ['IfcPositiveLengthMeasure', (v: number) => v > 0],
  ['IfcNonNegativeLengthMeasure', (v: number) => v >= 0],
  ['IfcPositiveRatioMeasure', (v: number) => v > 0],
  ['IfcNormalisedRatioMeasure', (v: number) => v >= 0 && v <= 1],
  ['IfcPositivePlaneAngleMeasure', (v: number) => v > 0],
  ['IfcPositiveInteger', (v: number) => v > 0],
  // The two the name-shaped alarm could not see (#3268). Neither carries
  // `Positive` / `NonNegative` / `Normalised` in its name, so the drift test
  // that was supposed to keep this table closed stayed green while the
  // exporter re-declared `IFCPHMEASURE(99.)` and
  // `IFCHEATINGVALUEMEASURE(-5.)` — schema-invalid lines that a source file
  // could never have contained, written by the gate whose whole purpose is to
  // refuse a type it cannot justify. The drift test now derives the set from
  // the bundled EXPRESS schemas instead of guessing it from names.
  ['IfcPHMeasure', (v: number) => v >= 0 && v <= 14],
  ['IfcHeatingValueMeasure', (v: number) => v > 0],
]);

/**
 * Exported for the drift test only: the members {@link CONSTRAINED_MEMBERS}
 * claims to cover, so the test holds the table against the LIVE registry rather
 * than against a second copy of the same list.
 */
export const CONSTRAINED_IFC_VALUE_MEMBERS: readonly string[] = [...CONSTRAINED_MEMBERS.keys()];

/**
 * The nearest ancestor of `name` along the registry's alias chain that is itself
 * an `IfcValue` member over the SAME EXPRESS base and carries no constraint —
 * `IfcPositiveLengthMeasure` → `IfcLengthMeasure`, `IfcNormalisedRatioMeasure` →
 * `IfcRatioMeasure`. `null` when the chain leaves `IfcValue` before reaching one,
 * in which case the caller falls back to the shape-derived primitive.
 */
function relaxedMember(name: string, base: string): string | null {
  const seen = new Set<string>([name]);
  let cursor: string | undefined = SCHEMA_REGISTRY.types[name];
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const leaf = lookupNominalValueLeaf(cursor.toUpperCase());
    if (leaf && leaf[1] === base && !CONSTRAINED_MEMBERS.has(leaf[0])) return leaf[0];
    cursor = SCHEMA_REGISTRY.types[cursor];
  }
  return null;
}

/**
 * The schema-cased `IfcValue` member a regenerated property is written back
 * with, else `null` for the shape-derived fallback. See the module docstring for
 * the four gates. Normally this is `dataType`'s own member; for a value outside
 * a CONSTRAINED member's domain it is that member's nearest unconstrained
 * ancestor (gate 4).
 */
export function declaredNominalValueType(
  value: unknown,
  type: PropertyValueType,
  dataType: string | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  // The caller NAMED a member rather than echoing a shape (#3715), so it
  // outranks the source token even inside one EXPRESS base — see gate 2.
  // A non-string value is left exactly where it was: `valueFitsBase` would
  // have rejected it below, and `serializePropertyValue` writes the same
  // token for these three anyway, so this branch changes nothing for it.
  const named = NAMED_MEMBERS.get(type);
  if (named !== undefined) return typeof value === 'string' ? named : null;
  if (!dataType) return null;
  const leaf = lookupNominalValueLeaf(dataType.trim().toUpperCase());
  if (!leaf) return null;
  const [name, base] = leaf;
  const accepted = acceptedBases(type);
  if (!accepted || !accepted.includes(base)) return null;
  if (!valueFitsBase(value, base)) return null;
  const constraint = CONSTRAINED_MEMBERS.get(name);
  // `valueFitsBase` has already established a finite number for every base a
  // constrained member resolves to (REAL / NUMBER / INTEGER) — not a coercion.
  if (constraint && !constraint(value as number)) return relaxedMember(name, base);
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
