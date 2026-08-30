/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure STEP format serialization utilities.
 *
 * All functions in this module are pure (no side-effects, no external state)
 * and deal exclusively with converting data to ISO 10303-21 STEP format strings.
 *
 * Three neighbours are deliberately NOT here, because none turns a value into
 * a token and each has rules of its own worth finding on its own:
 *   - `step-argument-parser.ts` reads a record's arguments back OUT of a line
 *     and writes one slot by index (`splitTopLevelArgs`, `replaceStepArgument`,
 *     `splitTopLevelStepArguments`);
 *   - `step-file-assembly.ts` joins a finished header and finished entity lines
 *     into the delivered file (`assembleStepBytes`, `assembleStepBlob`);
 *   - `property-value-serialization.ts` (split out by #3184) is the IFC
 *     property `NominalValue` token for a `PropertyValueType`
 *     (`serializePropertyValue`) — the property-TYPE-NAME mapping table, not a
 *     generic STEP token, and worth reading on its own.
 */

import { serializeValue, SCHEMA_REGISTRY, type IfcAttributeValue } from '@ifc-lite/parser';
import { QuantityType, formatStepReal, escapeStepString } from '@ifc-lite/data';

/**
 * Re-exported so every existing `import { escapeStepString } from
 * './step-serialization.js'` call site keeps working. The implementation
 * lives once, in `@ifc-lite/data` (#3300) — this package used to keep its
 * own byte-identical copy, which is exactly the duplication
 * `packages/codegen/test/serialization-generator.test.ts` already forbids
 * for the schema-agnostic serializer bundles.
 */
export { escapeStepString };

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
    // Own-property, not bare bracket access: SCHEMA_REGISTRY.types is a plain
    // object literal, so `types['constructor']` reaches Object.prototype and
    // hands back the Object CONSTRUCTOR. That is truthy, so the `!underlying`
    // check below passes it through and `.replace()` on the next line throws
    // `TypeError: underlying.replace is not a function` from a function whose
    // contract is to return null for a type it does not know. Sibling of #3063.
    const underlying: string | undefined = Object.prototype.hasOwnProperty.call(SCHEMA_REGISTRY.types, cursor)
      ? SCHEMA_REGISTRY.types[cursor]
      : undefined;
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
    case QuantityType.Number: return 'IFCQUANTITYNUMBER';
    default: return 'IFCQUANTITYCOUNT';
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
