/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared helpers for extracting typed values from IFC entity attributes.
 * Used across material, georef, and classification extractors.
 */

export function getString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  return String(value);
}

export function getNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  // Both branches are guarded, not just the string one. A caller can hand this
  // helper a number directly — `getNumber(entity.attributes[7])` where the
  // extractor already produced one, or a literal from a caller's own
  // arithmetic — and `Infinity`/`NaN` are `typeof 'number'`. Guarding only the
  // parse below would make the contract "finite, unless you passed a number",
  // which is not a contract.
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const num = parseFloat(value);
    // Number.isFinite, not !isNaN: `parseFloat('1.0E400')` is `Infinity` and
    // `isNaN(Infinity)` is `false`. This helper's callers (georeferencing
    // eastings/northings/scale, material layer thickness, classification
    // numerics) all feed exported geometry and property values, where an
    // infinity becomes `null` on the way out of `JSON.stringify`. The
    // signature is `number | undefined`, so the only honest answer for a
    // value that is not a finite number is "absent".
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

/**
 * True when `raw` is a token the extractor preserved verbatim *because* the
 * number it names overflows the IEEE-754 double range — `1.0E400`.
 *
 * `parseAttributeValue` returns the raw token for anything it cannot represent
 * as a finite number, so a string in a numeric attribute slot is ambiguous: it
 * may be an enumeration, a mis-typed label, or a real the double range cannot
 * hold. Only the last is an *unrepresentable number*, and only that case is
 * this predicate's business. Callers whose value type is `number` use it to
 * refuse rather than substitute a plausible-looking `0`.
 *
 * `parseFloat`, matching `parseAttributeValue`: it is what decided the token
 * was non-finite in the first place, and `Number('1.0E400abc')` disagrees with
 * `parseFloat('1.0E400abc')`. `NaN` is deliberately NOT included — a `NaN`
 * token was already a raw string before non-finite guarding, so it is an
 * ordinary unparseable label, not a number that overflowed.
 */
export function isOverflowingNumericLiteral(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const num = parseFloat(raw);
  return num === Infinity || num === -Infinity;
}

export function getBoolean(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === '.T.' || value === 'T' || value === 'true') return true;
  if (value === '.F.' || value === 'F' || value === 'false') return false;
  return undefined;
}

export function getReference(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  // Guarded on the number branch too: an express id is an integer key into the
  // entity map, and `Infinity` names no entity while colliding with every
  // other overflowing id. `NaN` never matches anything, including itself.
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.startsWith('#')) {
    // Number.isFinite, not !Number.isNaN: a 400-digit id overflows to Infinity,
    // which is not NaN but names no entity.
    const num = parseInt(value.substring(1));
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

export function getReferences(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(v => getReference(v))
    .filter((ref): ref is number => ref !== undefined);
}

export function getStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(v => getString(v))
    .filter((str): str is string => str !== undefined);
}
