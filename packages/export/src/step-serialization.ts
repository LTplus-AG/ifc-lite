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
import { PropertyValueType, QuantityType } from '@ifc-lite/data';

/**
 * Escape a string for STEP format (backslash and single-quote escaping).
 */
export function escapeStepString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''");
}

/**
 * Convert a number to a valid STEP REAL literal.
 * Handles NaN/Infinity (-> 0.) and ensures a decimal point is present.
 */
export function toStepReal(v: number): string {
  if (!Number.isFinite(v)) return '0.';
  const s = v.toString();
  return s.includes('.') ? s : s + '.';
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
      return `IFCREAL(${num.toString().includes('.') ? num : num + '.'})`;
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

  if (current.trim() || text.endsWith(',')) {
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
