/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `serializePropertyValue`: the IFC property `NominalValue` token for a
 * `PropertyValueType`. Split out of `step-serialization.ts` (#3184) — the
 * rest of that module is generic STEP token serialization (escaping, typed
 * markers, attribute-value inference), while this one function is the IFC
 * property-type-name mapping table its own doc comment discusses at length
 * (#2472, #2488).
 */

import { PropertyValueType, formatStepReal } from '@ifc-lite/data';
import { escapeStepString } from './step-serialization.js';

/**
 * Serialize a property value to STEP format (e.g. IFCLABEL, IFCREAL, etc.).
 *
 * The token this writes is the property's DECLARED TYPE in the exported file, so
 * every member below has to name the IFC primitive the value was authored as —
 * not merely one that can hold the characters. Two did not (#2472):
 *
 *   - `Text` was written as `IFCLABEL`. `IfcLabel` is a bounded, name-like
 *     string; `IfcText` is unbounded prose. A consumer read a different type
 *     than the property was created with, and a long value exceeded what
 *     `IfcLabel` is specified to carry.
 *   - `Logical` was written as `IFCBOOLEAN` for its two definite states.
 *     `IfcBoolean` has two values; `IfcLogical` has three, and `.U.` is the
 *     reason a property is Logical rather than Boolean in the first place.
 *
 * Neither could be caught by a value-level round-trip: the extractor collapses
 * every string-valued token (`IFCLABEL`, `IFCTEXT`, `IFCIDENTIFIER`) to
 * `PropertyValueType.String` and keeps the token name only in `dataType`, so
 * the VALUE survives export/re-import through the wrong wrapper unchanged. Only
 * an assertion on the emitted token sees the difference — which is what
 * `property-value-serialization.test.ts` makes.
 *
 * `@ifc-lite/collab`'s `PROPERTY_TYPE_NAMES` is the same table for a different
 * transport, and it already named `Text` and `Logical` correctly — so on THOSE
 * TWO MEMBERS the two agree now. Not on the table as a whole, and this pass does
 * not make them agree:
 *
 *   - `String`: collab says `IfcText`, this says `IFCLABEL`. Both are guesses
 *     about a token the extractor did not keep, and they guess in opposite
 *     directions (unbounded prose vs the conservative bounded name). Changing
 *     either is a behaviour change to the OTHER transport's payload, out of
 *     #2472's scope, and it needs the argument about which guess is right made
 *     first — not a silent alignment.
 *   - `List`: collab says `IfcText`; this writes a STEP aggregate `(...)` of
 *     `IFCLABEL` items, which is not a NominalValue token at all.
 *
 * `Enum` was the third disagreement — collab said `IfcLabel`, this wrote a bare
 * `.TOKEN.` — and #2488 settled it on collab's side, for the reason the case
 * below states: the bare token is not a member of the SELECT at all.
 *
 * `Label`, `Identifier`, `Real`, `Integer`, `Boolean`, `Text`, `Logical`, `Enum`
 * and `Reference` agree.
 */
export function serializePropertyValue(value: unknown, type: PropertyValueType): string {
  if (value === null || value === undefined) {
    // `Logical` is the one member with a value FOR "no value": the extractor
    // reads `.U.` / `.X.` back as a null-valued Logical, so `$` here would
    // turn an explicit unknown into an omitted attribute on re-export.
    if (type === PropertyValueType.Logical) return `IFCLOGICAL(.U.)`;
    return '$';
  }

  switch (type) {
    // `String` is the extractor's catch-all for any string-valued token whose
    // declared type it did not keep, so it stays the bounded `IfcLabel`: the
    // conservative direction for an unknown short string, and what
    // `PROPERTY_TYPE_NAMES` calls `Enum` and `Reference` too.
    case PropertyValueType.String:
    case PropertyValueType.Label:
      return `IFCLABEL('${escapeStepString(String(value))}')`;

    case PropertyValueType.Text:
      return `IFCTEXT('${escapeStepString(String(value))}')`;

    case PropertyValueType.Identifier:
      return `IFCIDENTIFIER('${escapeStepString(String(value))}')`;

    case PropertyValueType.Real: {
      const num = Number(value);
      if (!Number.isFinite(num)) return '$';
      return `IFCREAL(${formatStepReal(num)})`;
    }

    case PropertyValueType.Integer:
      return `IFCINTEGER(${Math.round(Number(value))})`;

    case PropertyValueType.Boolean:
      if (value === true) return `IFCBOOLEAN(.T.)`;
      if (value === false) return `IFCBOOLEAN(.F.)`;
      // A Boolean whose value is neither: no `IfcBoolean` literal says that, and
      // `.U.` is not in its domain, so the three-state primitive is the only
      // thing that can carry it. Unchanged from before #2472 — the Logical case
      // below is what stopped borrowing IfcBoolean's name for it.
      return `IFCLOGICAL(.U.)`;

    case PropertyValueType.Logical:
      if (value === true) return `IFCLOGICAL(.T.)`;
      if (value === false) return `IFCLOGICAL(.F.)`;
      return `IFCLOGICAL(.U.)`;

    // `NominalValue` is declared `IfcValue`, and `IfcValue` has no ENUMERATION
    // leaf in any schema this exporter targets (IFC2X3 / IFC4 / IFC4X3 all
    // resolve it to IfcMeasureValue | IfcSimpleValue | IfcDerivedMeasureValue).
    // So there is no wrapper for an enumeration token and a bare `.EXTERNAL.`
    // is not a member of the SELECT at all — this was the one branch writing an
    // unqualified token into a slot every other branch type-qualifies (#2488).
    // `IfcLabel` is what the value can be expressed as, and what
    // `@ifc-lite/collab`'s `PROPERTY_TYPE_NAMES` has always called this member.
    //
    // No `.toUpperCase()`: it existed to build an EXPRESS enumeration name,
    // which is upper-case by construction. A label is not, and folding the case
    // means an authored `'external'` reads back as `'EXTERNAL'`. Nothing
    // EXTRACTS an `Enum` (the extractor collapses every string-valued token to
    // `String`), so this branch only ever serializes a value a session authored
    // through `setProperty(…, PropertyValueType.Enum)` — the value the caller
    // wrote is the one to keep.
    case PropertyValueType.Enum:
      return `IFCLABEL('${escapeStepString(String(value))}')`;

    case PropertyValueType.List:
      if (Array.isArray(value)) {
        const items = value.map(v => serializePropertyValue(v, PropertyValueType.String));
        return `(${items.join(',')})`;
      }
      return '$';

    // Includes `Reference`, which no extraction path produces (an
    // `IfcPropertyReferenceValue` comes back as a String holding `#id`) and
    // which this function could not express anyway: an entity reference is a
    // different property CLASS, not a different `NominalValue` token.
    default:
      return `IFCLABEL('${escapeStepString(String(value))}')`;
  }
}
