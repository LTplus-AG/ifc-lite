/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure STEP format serialization utilities.
 *
 * All functions in this module are pure (no side-effects, no external state)
 * and deal exclusively with converting data to ISO 10303-21 STEP format strings.
 */

import { serializeValue, type IfcAttributeValue } from '@ifc-lite/parser';
import { PropertyValueType, QuantityType, formatStepReal } from '@ifc-lite/data';

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
 */
export function serializePropertyValue(value: unknown, type: PropertyValueType): string {
  if (value === null || value === undefined) {
    return '$';
  }

  switch (type) {
    case PropertyValueType.String:
    case PropertyValueType.Label:
    case PropertyValueType.Text:
      return `IFCLABEL('${escapeStepString(String(value))}')`;

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
    case PropertyValueType.Logical:
      if (value === true) return `IFCBOOLEAN(.T.)`;
      if (value === false) return `IFCBOOLEAN(.F.)`;
      return `IFCLOGICAL(.U.)`;

    case PropertyValueType.Enum:
      return `.${String(value).toUpperCase()}.`;

    case PropertyValueType.List:
      if (Array.isArray(value)) {
        const items = value.map(v => serializePropertyValue(v, PropertyValueType.String));
        return `(${items.join(',')})`;
      }
      return '$';

    default:
      return `IFCLABEL('${escapeStepString(String(value))}')`;
  }
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
 */
export function serializeStepValue(value: IfcAttributeValue): string {
  if (value === null || value === undefined) return '$';
  if (typeof value === 'boolean') return value ? '.T.' : '.F.';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '$';
    return Number.isInteger(value) ? String(value) : toStepReal(value);
  }
  if (Array.isArray(value)) {
    return `(${value.map(serializeStepValue).join(',')})`;
  }
  const trimmed = String(value).trim();
  if (trimmed === '$' || trimmed === '*') return trimmed;
  if (/^#\d+$/.test(trimmed)) return trimmed;
  if (/^\.[A-Z0-9_]+\.$/i.test(trimmed)) return trimmed.toUpperCase();
  return `'${escapeStepString(String(value))}'`;
}

/**
 * Serialize an attribute list to a STEP entity body.
 * Example: `[1, '.AREA.', null]` → `1,.AREA.,$`
 */
export function serializeStepArgs(values: IfcAttributeValue[]): string {
  return values.map(serializeStepValue).join(',');
}

/** Tag a number as a STEP entity reference (`#N`) for `serializeStepValue`. */
export function entityRef(expressId: number): string {
  return `#${expressId}`;
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
 * Split a STEP argument list on top-level commas while preserving nested syntax.
 * Similar to `splitTopLevelArgs` but uses a slightly different accumulation style
 * suited for the `replaceEntityAttribute` call-site.
 */
export function splitTopLevelStepArguments(input: string): string[] {
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
      else if (char === ')') depth--;
      else if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }

    current += char;
  }

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
