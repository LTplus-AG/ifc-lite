/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure STEP format serialization utilities.
 *
 * All functions in this module are pure (no side-effects, no external state)
 * and deal exclusively with converting data to ISO 10303-21 STEP format strings.
 */

import { serializeValue, SCHEMA_REGISTRY, type IfcAttributeValue } from '@ifc-lite/parser';
import { PropertyValueType, QuantityType, formatStepReal } from '@ifc-lite/data';

/** EXPRESS base primitives a defined type ultimately resolves to. */
const EXPRESS_PRIMITIVES = new Set(['BOOLEAN', 'LOGICAL', 'INTEGER', 'REAL', 'NUMBER', 'STRING', 'BINARY']);

/**
 * Resolve an IFC defined type (`IfcLengthMeasure`, `IfcPositiveLengthMeasure`,
 * `IfcBoolean`, …) to its underlying EXPRESS primitive (`REAL`, `BOOLEAN`, …)
 * by walking the schema registry's `types` alias chain. Returns `null` for a
 * type the registry doesn't know or one that bottoms out in an entity/select.
 */
export function resolveExpressBase(typeName: string): string | null {
  let cursor: string | undefined = typeName;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const underlying: string | undefined = SCHEMA_REGISTRY.types[cursor];
    if (!underlying) return null;
    // Strip width qualifiers like `STRING(255)` before the primitive test.
    const head = underlying.replace(/\(.*$/, '').trim().toUpperCase();
    if (EXPRESS_PRIMITIVES.has(head)) return head;
    cursor = underlying; // nested alias, e.g. IfcPositiveLengthMeasure -> IfcLengthMeasure
  }
  return null;
}

/**
 * Interpret a `{ typed }` marker's boolean/logical inner value. The marker
 * accepts `string | number | boolean`, so a caller may copy a value straight
 * from the parser as a STEP token string (`'.T.'`/`'.F.'`/`'.U.'`) or a word
 * (`'true'`). A plain JS truthiness test would corrupt these — `'.F.'` is a
 * truthy string — so normalize to a tri-state: `true` / `false` / `null`
 * (unknown, valid only for LOGICAL).
 */
function coerceLogical(value: string | number | boolean): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const t = value.trim().toUpperCase();
  if (t === 'TRUE' || t === '.T.' || t === 'T' || t === '1') return true;
  if (t === 'FALSE' || t === '.F.' || t === 'F' || t === '0') return false;
  return null;
}

/**
 * Serialize the inner value of a type-qualified token according to the resolved
 * EXPRESS primitive of its declared type. REAL/NUMBER always carry a decimal
 * point; BOOLEAN/LOGICAL emit `.T.`/`.F.`/`.U.`; STRING/BINARY are quoted.
 * An unresolved base falls back to inferring from the JS value.
 */
function serializeInnerByBase(value: string | number | boolean, base: string | null): string {
  switch (base) {
    case 'REAL':
    case 'NUMBER':
      return toStepReal(Number(value));
    case 'INTEGER':
      return String(Math.trunc(Number(value)));
    case 'BOOLEAN':
      // A BOOLEAN has no unknown state; an unrecognized token coerces to `.F.`.
      return coerceLogical(value) === true ? '.T.' : '.F.';
    case 'LOGICAL': {
      const logical = coerceLogical(value);
      return logical === true ? '.T.' : logical === false ? '.F.' : '.U.';
    }
    case 'STRING':
    case 'BINARY':
      return `'${escapeStepString(String(value))}'`;
    default:
      if (typeof value === 'boolean') return value ? '.T.' : '.F.';
      if (typeof value === 'number') return Number.isInteger(value) ? String(value) : toStepReal(value);
      return `'${escapeStepString(String(value))}'`;
  }
}

/**
 * Serialize a type-qualified STEP value `IFC<TYPE>(<inner>)` — the form a SELECT
 * member that is a defined type requires (`IFCBOOLEAN(.T.)`,
 * `IFCLENGTHMEASURE(3.)`). `type` is the IFC type name (`'IfcBoolean'`); the
 * inner value is serialized to match that type's underlying primitive.
 */
export function serializeTypedMarker(type: string, value: string | number | boolean): string {
  let token = type.toUpperCase();
  if (!token.startsWith('IFC')) token = `IFC${token}`;
  return `${token}(${serializeInnerByBase(value, resolveExpressBase(type))})`;
}

/**
 * Escape a string for STEP format (backslash and single-quote escaping).
 *
 * Control characters (CR/LF and other C0 codes) are collapsed to a single
 * space so every generated STEP entity stays on one physical line and
 * round-trips through the line-oriented merge/convert paths.
 */
export function escapeStepString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]+/g, ' ');
}

/**
 * Convert a number to a valid STEP REAL literal.
 *
 * Handles NaN/Infinity (-> `0.`) and delegates the mantissa/`E` rewrite to the
 * shared {@link formatStepReal} so exponential magnitudes serialize as valid
 * STEP (`5e-8` -> `5.E-8`, `1e21` -> `1.E+21`, `1.5e-7` -> `1.5E-7`) rather than
 * the invalid `5e-8.` / lowercase-`e` forms a bare decimal-point append produced.
 */
export function toStepReal(v: number): string {
  if (!Number.isFinite(v)) return '0.';
  return formatStepReal(v);
}

/**
 * Map QuantityType enum to IFC STEP entity type name.
 */
export function quantityTypeToIfcType(type: QuantityType): string {
  switch (type) {
    case QuantityType.Length: return 'IFCQUANTITYLENGTH';
    case QuantityType.Area: return 'IFCQUANTITYAREA';
    case QuantityType.Volume: return 'IFCQUANTITYVOLUME';
    case QuantityType.Count: return 'IFCQUANTITYCOUNT';
    case QuantityType.Weight: return 'IFCQUANTITYWEIGHT';
    case QuantityType.Time: return 'IFCQUANTITYTIME';
    default: return 'IFCQUANTITYCOUNT';
  }
}

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
 *   - `Enum`: collab says `IfcLabel`; this writes a bare `.TOKEN.` (#2488).
 *
 * `Label`, `Identifier`, `Real`, `Integer`, `Boolean`, `Text`, `Logical` and
 * `Reference` agree.
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

    case PropertyValueType.Enum:
      return `.${String(value).toUpperCase()}.`;

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

/**
 * True when a STEP source token is a REAL literal — a numeric token carrying a
 * decimal point or an exponent (`0.4`, `+0.4`, `1.5E-7`, `4.`). Used to
 * preserve REAL-ness when a positional edit replaces such a value with a whole
 * number, so `1` written over `0.4` re-emits as `1.` rather than a bare INTEGER.
 * A leading `+` is a valid ISO 10303-21 sign, so it is accepted alongside `-`.
 */
export function tokenIsRealLiteral(token: string): boolean {
  const t = token.trim();
  return /^[+-]?\d+(?:\.\d*)?(?:E[+-]?\d+)?$/i.test(t) && (t.includes('.') || /E/i.test(t));
}

/**
 * Serialize a root attribute value for STEP, inferring the format from the
 * existing token (enum, boolean, number, string, etc.).
 */
export function serializeAttributeValue(value: string, currentToken: string): string {
  const trimmed = value.trim();
  const current = currentToken.trim();

  // A source attribute already written as a quoted STEP string stays one: user
  // free-text is emitted as a properly quoted+escaped string and NEVER
  // reinterpreted as a typed token. Otherwise a Name of `#12` would silently
  // become an entity reference, `$`/`*` a null/derived marker, `.FOO.` an enum,
  // and an apostrophe-bearing value would break the record — corrupting the file.
  if (current.length >= 2 && current.startsWith("'") && current.endsWith("'")) {
    if (value === '') return '$';
    return `'${escapeStepString(value)}'`;
  }

  if (value === '') return '$';
  if (trimmed === '$' || trimmed === '*') return trimmed;
  if (/^#\d+$/.test(trimmed)) return trimmed;

  if (/^\.[A-Z0-9_]+\.$/i.test(current) || /^\.[A-Z0-9_]+\.$/i.test(trimmed)) {
    return `.${trimmed.replace(/^\./, '').replace(/\.$/, '').toUpperCase()}.`;
  }

  if (/^(?:\.T\.|\.F\.|\.U\.)$/i.test(current)) {
    const normalized = trimmed.toLowerCase();
    if (normalized === 'true' || normalized === '.t.') return '.T.';
    if (normalized === 'false' || normalized === '.f.') return '.F.';
    return '.U.';
  }

  if (/^-?\d+(?:\.\d+)?(?:E[+-]?\d+)?$/i.test(trimmed) && /^-?\d/.test(current)) {
    const numberValue = Number(trimmed);
    if (!Number.isFinite(numberValue)) return '$';
    return current.includes('.') || /E/i.test(current)
      ? toStepReal(numberValue)
      : String(numberValue);
  }

  return serializeValue(value);
}

/**
 * Serialize a single STEP attribute value to its on-disk token.
 *
 * - `null` / `undefined` → `$`
 * - booleans → `.T.` / `.F.`
 * - numbers → STEP integer or REAL literal
 * - strings starting with `#`, `.ENUM.`, `$`, `*` pass through unchanged
 *   (callers tag references as the string `"#42"` or via `entityRef(42)`)
 * - other strings are emitted as quoted STEP strings
 * - arrays are emitted as STEP lists `(a,b,c)`, recursing on each element
 *
 * `forceReal` makes whole numbers serialize as REAL literals (`450.`, not
 * `450`) and propagates into nested lists — used by the schema-aware export
 * path for attribute slots statically known to be REAL-backed (coordinates,
 * `IfcLengthMeasure` dimensions, …), where a bare INTEGER literal is an ISO
 * 10303-21 type violation strict validators reject (LTplus-AG/ifc-lite#1839).
 * It never overrides the explicit `{ real }` marker, which is always REAL.
 */
export function serializeStepValue(value: IfcAttributeValue, forceReal = false): string {
  if (value === null || value === undefined) return '$';
  if (typeof value === 'boolean') return value ? '.T.' : '.F.';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '$';
    if (forceReal) return toStepReal(value);
    return Number.isInteger(value) ? String(value) : toStepReal(value);
  }
  if (Array.isArray(value)) {
    return `(${value.map(v => serializeStepValue(v, forceReal)).join(',')})`;
  }
  if (typeof value === 'object' && 'real' in value) {
    // Write-only typed-real marker (see `IfcAttributeValue`): always a REAL
    // literal with a decimal point, even for whole numbers.
    return toStepReal(value.real);
  }
  if (typeof value === 'object' && 'typed' in value) {
    // Write-only typed-value marker (see `IfcAttributeValue`): a type-qualified
    // token `IFC<TYPE>(<value>)` for SELECT members / the IfcValue family.
    return serializeTypedMarker(value.typed.type, value.typed.value);
  }
  const trimmed = String(value).trim();
  if (trimmed === '$' || trimmed === '*') return trimmed;
  if (/^#\d+$/.test(trimmed)) return trimmed;
  if (/^\.[A-Z0-9_]+\.$/i.test(trimmed)) return trimmed.toUpperCase();
  return `'${escapeStepString(String(value))}'`;
}

/** Tag a number as a STEP entity reference (`#N`) for `serializeStepValue`. */
export function entityRef(expressId: number): string {
  return `#${expressId}`;
}

/**
 * Tag a number as a STEP REAL for `serializeStepValue`, forcing a decimal
 * point even for whole numbers (`5.` not `5`). Required for typed measures
 * (`IfcLengthMeasure` coordinates and friends) where an integer literal is a
 * STEP type violation.
 */
export function stepReal(value: number): { real: number } {
  return { real: value };
}

/**
 * Split a STEP argument list on top-level commas, respecting nested
 * parentheses and quoted strings. Used by `applyAttributeMutations`.
 */
export function splitTopLevelArgs(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    current += char;

    if (inString) {
      if (char === '\'') {
        if (text[i + 1] === '\'') {
          current += text[i + 1];
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (char === '\'') {
      inString = true;
      continue;
    }

    if (char === '(') {
      depth++;
      continue;
    }

    if (char === ')') {
      depth--;
      continue;
    }

    if (char === ',' && depth === 0) {
      parts.push(current.slice(0, -1).trim());
      current = '';
    }
  }

  // Trailing tokens: only push if there's actual content. The previous
  // `text.endsWith(',')` check pushed an empty trailing token for inputs
  // like `"a,"`, producing `['a', '']` — STEP doesn't allow trailing
  // commas, so the right answer is just `['a']`. Empty interior args
  // (e.g. `"a,,b"` → `['a', '', 'b']`) are still produced because the
  // comma branch above handles them.
  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

/**
 * Replace ONE top-level argument of a STEP record, by zero-based slot, leaving
 * every other token — and the record's class keyword and id — byte-identical.
 *
 * Takes the LINE, not an expressId: the caller may hold a line that is no
 * longer what the source buffer says. The type-object `HasPropertySets`
 * rewrite is exactly that case — it hands in a line the retype / attribute /
 * positional pipeline has already rewritten, and re-reading the buffer here
 * would throw all of that away (which is how that path used to drop every
 * edit but the pset repoint).
 *
 * Returns null when the text is not a parseable single STEP record or the slot
 * is past the end of the argument list; a null must not be treated as "no
 * change", since the intended replacement did not happen.
 *
 * The regex only pins the two ENDS of the record — `#N=CLASS(` and `);`. Text
 * malformed BETWEEN them is caught by {@link splitTopLevelStepArguments}, which
 * rejects an argument list it could not scan cleanly rather than handing back
 * whatever it accumulated: those parts are not the record's slots, so writing
 * one lands on the wrong argument and reports a success that did not happen
 * (#2470). Silently corrupted output instead of a dropped entity, same class.
 */
export function replaceStepArgument(
  entityText: string,
  attrIndex: number,
  replacement: string,
): string | null {
  const match = entityText.match(/^(#\d+\s*=\s*\w+\()([\s\S]*)(\)\s*;)\s*$/);
  if (!match) return null;

  const [, prefix, attrsText, suffix] = match;
  const attrs = splitTopLevelStepArguments(attrsText);
  // Load-bearing, and covered: the bounds check below READS `attrs.length`, so a
  // null reaches it as a TypeError rather than falling through to a rejection.
  // Deleting this line fails exactly the three malformed-input cases in
  // `step-serialization.test.ts` — unterminated string, unbalanced list, stray
  // closing paren — which throw instead of returning null. Kept as its own line,
  // not folded into that check, because "could not scan it" and "that slot is
  // past the end" are different facts about the input.
  if (attrs === null) return null;
  // A negative or fractional slot must not reach the assignment below: it would
  // set a NAMED PROPERTY on the array rather than an element, `join` would skip
  // it, and this would hand back the line unchanged — but non-null, which the
  // contract above says means the replacement happened. `rewriteTypeOwnedPsetLine`
  // reads that as `repointed: true` and would report a repoint that never
  // occurred. Unreachable today (the only slot is a constant), guarded because
  // the function is exported and the non-null contract is load-bearing.
  if (!Number.isInteger(attrIndex) || attrIndex < 0 || attrIndex >= attrs.length) return null;

  attrs[attrIndex] = replacement;
  return `${prefix}${attrs.join(',')}${suffix}`;
}

/**
 * Split a STEP argument list on top-level commas while preserving nested syntax,
 * or null when the text is not a well-formed argument list.
 *
 * Similar to `splitTopLevelArgs` but uses a slightly different accumulation style
 * suited for the {@link replaceStepArgument} call-site.
 *
 * ## Why it validates
 *
 * The scan already tracks quote state and paren depth to know where a top-level
 * comma is. It used to ignore the final state, so text that never left a string
 * or never closed a list still produced parts — parts whose boundaries are
 * wherever the scanner happened to be, not the record's slots. Both callers then
 * acted on them: `replaceStepArgument` wrote a slot by index and reported
 * success, and the unit rescale multiplied numbers in whatever argument the
 * mis-split had put them in. Neither could tell, because a broken split looks
 * exactly like a good one.
 *
 * Rejected, because after either of these the parts are no longer the record's
 * arguments — commas were swallowed and everything past them shifted:
 *   - a quote left open at the end (unterminated string);
 *   - a paren depth that does not return to zero, or that ever goes below it
 *     (unbalanced or stray-closing nested list). Both ends matter: a depth that
 *     dips negative and climbs back looks balanced at the end while every comma
 *     in between was read as nested.
 *
 * An EMPTY top-level slot (`a,,b`, or a trailing comma) is deliberately NOT
 * rejected, though it is invalid STEP. It costs no alignment: an empty argument
 * is ONE part, exactly as the entity parser counts it, so every index still
 * names the attribute it is meant to and the replacement lands where it should.
 * Rejecting it made things strictly worse, and measurably: the parser resolves
 * `HasPropertySets` on such a line, so a session deleting that type object's
 * property set has already had the pset's lines WITHHELD by the time the repoint
 * runs — refuse the repoint and the record keeps a `#id` pointing at a property
 * set the export just dropped. A dangling reference is worse than a
 * still-invalid-but-unchanged empty slot.
 *
 * An empty INPUT is not an empty slot: `#1=IFCFOO();` is a record with no
 * arguments, so it splits to `[]` and any slot request then fails the bounds
 * check in {@link replaceStepArgument} — which is the right answer for a record
 * that has no slots.
 */
export function splitTopLevelStepArguments(input: string): string[] | null {
  if (input.trim() === '') return [];

  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === "'") {
      current += char;
      if (inString && i + 1 < input.length && input[i + 1] === "'") {
        current += input[i + 1];
        i++;
        continue;
      }
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '(') depth++;
      else if (char === ')') {
        depth--;
        // Already past the record's own closing paren: every comma from here
        // would be read as nested and the split is meaningless.
        if (depth < 0) return null;
      } else if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }

    current += char;
  }

  if (inString || depth !== 0) return null;
  parts.push(current);
  return parts;
}

/**
 * Worst-case UTF-8 bytes per UTF-16 code unit: a lone BMP code unit needs at
 * most 3 bytes, and a surrogate pair (2 units) needs 4 bytes for its combined
 * codepoint — 2 bytes/unit, under the 3x bound. An unpaired surrogate is
 * replaced with U+FFFD (3 bytes) by both `TextEncoder` and `Blob`, which also
 * fits. `str.length * UTF8_WORST_CASE_BYTES_PER_UNIT` therefore always fits
 * the full encoding.
 */
const UTF8_WORST_CASE_BYTES_PER_UNIT = 3;

/**
 * Assemble a STEP file from header and entity lines as a Uint8Array.
 *
 * Two passes over `entities`, no intermediate per-entity byte arrays:
 * 1. `TextEncoder.encodeInto` each entity into a reusable (grow-on-demand)
 *    scratch buffer just to learn its exact encoded byte length — the
 *    scratch bytes themselves are discarded.
 * 2. Allocate the ONE final buffer sized from the lengths computed in pass 1,
 *    then `encodeInto` each entity directly into its slice.
 *
 * This replaces a previous single-pass version that kept a persistent
 * `Uint8Array[]` of every encoded entity alive simultaneously (a second full
 * copy of the file's content) purely to learn the sizes needed to allocate
 * the final buffer. Output is byte-identical to that version.
 *
 * Shared by the STEP and merged exporters (was duplicated byte-for-byte in
 * both — alignment audit).
 */
export function assembleStepBytes(header: string, entities: string[]): Uint8Array {
  const encoder = new TextEncoder();

  const headBytes = encoder.encode(`${header}DATA;\n`);
  const tailBytes = encoder.encode('ENDSEC;\nEND-ISO-10303-21;\n');

  // Pass 1: exact per-entity byte length via encodeInto into scratch space
  // (grown on demand), so the final buffer can be allocated once.
  let scratch = new Uint8Array(4096);
  const entityLengths = new Array<number>(entities.length);
  let totalSize = headBytes.byteLength + tailBytes.byteLength;
  for (let i = 0; i < entities.length; i++) {
    const str = entities[i];
    const worstCase = str.length * UTF8_WORST_CASE_BYTES_PER_UNIT;
    if (scratch.byteLength < worstCase) {
      scratch = new Uint8Array(Math.max(worstCase, scratch.byteLength * 2));
    }
    const { written } = encoder.encodeInto(str, scratch);
    entityLengths[i] = written;
    totalSize += written + 1; // +1 for the trailing '\n'
  }

  // Pass 2: encode each entity directly into its slice of the one final buffer.
  const result = new Uint8Array(totalSize);
  let offset = 0;

  result.set(headBytes, offset);
  offset += headBytes.byteLength;

  for (let i = 0; i < entities.length; i++) {
    const len = entityLengths[i];
    encoder.encodeInto(entities[i], result.subarray(offset, offset + len));
    offset += len;
    result[offset] = 0x0a; // '\n'
    offset += 1;
  }

  result.set(tailBytes, offset);
  return result;
}

/**
 * Assemble a STEP file as a multi-part `Blob` instead of one contiguous
 * `Uint8Array`. Built directly from the header, entity strings, and
 * newlines as separate `BlobPart`s — there is no final contiguous copy of
 * the file's content in JS heap memory, since the browser stores/streams
 * each part (and encodes it to UTF-8) independently.
 *
 * Intended for the browser download path: `downloadBlob`
 * (`apps/viewer/src/lib/export/download.ts`) accepts a `Blob` directly,
 * sidestepping the `Uint8Array`-is-not-a-`BlobPart` copy `downloadFile`
 * otherwise has to do under TS 5.7's stricter `BlobPart` typing.
 *
 * Byte content is identical to `assembleStepBytes(header, entities)` — both
 * UTF-8-encode the same header/entity/newline/tail sequence, and `Blob`
 * string parts and `TextEncoder` follow the same WHATWG encoding spec
 * (including replacing unpaired surrogates with U+FFFD).
 */
export function assembleStepBlob(header: string, entities: string[]): Blob {
  const parts: BlobPart[] = new Array(entities.length * 2 + 2);
  parts[0] = `${header}DATA;\n`;
  let i = 1;
  for (const entity of entities) {
    parts[i++] = entity;
    parts[i++] = '\n';
  }
  parts[i] = 'ENDSEC;\nEND-ISO-10303-21;\n';
  return new Blob(parts, { type: 'model/step' });
}
