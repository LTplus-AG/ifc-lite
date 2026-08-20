/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure STEP format serialization utilities.
 *
 * All functions in this module are pure (no side-effects, no external state)
 * and deal exclusively with converting data to ISO 10303-21 STEP format strings.
 *
 * Two neighbours are deliberately NOT here, because neither turns a value into
 * a token and both have rules of their own worth finding on their own:
 *   - `step-argument-parser.ts` reads a record's arguments back OUT of a line
 *     and writes one slot by index (`splitTopLevelArgs`, `replaceStepArgument`,
 *     `splitTopLevelStepArguments`);
 *   - `step-file-assembly.ts` joins a finished header and finished entity lines
 *     into the delivered file (`assembleStepBytes`, `assembleStepBlob`).
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
 * Escape a string for STEP format: backslash and single-quote doubling, plus
 * non-ASCII directive encoding.
 *
 * Control characters (CR/LF and other C0 codes) are collapsed to a single
 * space so every generated STEP entity stays on one physical line and
 * round-trips through the line-oriented merge/convert paths.
 *
 * ISO 10303-21 6.3.3.4 restricts a string literal's plain-text bytes to the
 * "basic graphic" range 32-126; every other character is a control directive
 * (`\X\HH`, `\X2\HHHH\X0\`, `\X4\HHHHHHHH\X0\`), never a raw byte — and
 * buildingSMART's IFC string-encoding guidance states the same for the
 * IFC2X3/IFC4/IFC4X3 schemas this exporter targets: characters outside
 * decimal 32-126 "have to be encoded" (e.g. 'Ä' as `\X2\00C4\X0\`). A reader
 * that treats the file's bytes as ISO-8859-1 — the byte encoding the base
 * standard and most real consumers assume for these schemas — turns a raw
 * UTF-8 multi-byte sequence into mojibake or a broken parse; this exact
 * writer shape is a reported, reproduced defect in real IFC tooling
 * (IfcOpenShell#699/#1016; files rejected by Solibri). Encoded one character
 * at a time (never batching a run into one `\X2\...\X0\` block) to keep the
 * encoder trivially correct; ISO 10303-21 allows either.
 */
export function escapeStepString(str: string): string {
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]+/g, ' ');
  return encodeNonAsciiStepDirectives(escaped);
}

/**
 * Replace every character outside the STEP "basic graphic" range (32-126)
 * with its `\X2\`/`\X4\` directive. Must run AFTER backslash-doubling: the
 * directive's own backslashes are literal syntax the reader expects
 * undoubled, so escaping non-ASCII first would corrupt them when the
 * backslash-doubling pass ran afterward.
 */
function encodeNonAsciiStepDirectives(str: string): string {
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 32 && cp <= 126) {
      out += ch;
    } else if (cp <= 0xFFFF) {
      out += `\\X2\\${cp.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
    } else {
      out += `\\X4\\${cp.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
    }
  }
  return out;
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
