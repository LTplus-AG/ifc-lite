/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared helpers for extracting typed values from IFC entity attributes.
 * Used across material, georef, and classification extractors.
 */

import { isCompleteStepNumericLiteral } from '@ifc-lite/data';
import { isIndexableExpressId } from './express-id.js';

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
    const trimmed = value.trim();
    // `isCompleteStepNumericLiteral` first: `parseFloat` accepts any leading
    // numeric prefix and silently discards the rest, so `parseFloat('1.52.3')`
    // (a dropped comma between two reals) is `1.52` with no error, and
    // `parseFloat('1.5abc')` is `1.5`. Requiring the grammar match cover the
    // whole token before trusting `parseFloat`'s result closes that hole; the
    // `Number.isFinite` check below still catches the separate overflow
    // hazard (`parseFloat('1.0E400')` is `Infinity`, and `isNaN(Infinity)` is
    // `false`). This helper's callers (georeferencing eastings/northings/
    // scale, material layer thickness, classification numerics) all feed
    // exported geometry and property values, where an infinity becomes `null`
    // on the way out of `JSON.stringify`. The signature is `number |
    // undefined`, so the only honest answer for a value that is not a
    // complete, finite numeric literal is "absent".
    if (!isCompleteStepNumericLiteral(trimmed)) return undefined;
    const num = parseFloat(trimmed);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

/**
 * True when `token` starts like an attempted STEP numeric literal — a digit,
 * or `.` immediately followed by a digit, after an optional leading sign —
 * whether or not it turns out to be a complete one.
 *
 * This is the line between "corrupted number" and "ordinary non-numeric
 * token": an enumeration or identifier such as `.T.`, `.UNSPECIFIED.`, or `*`
 * does not start this way, so {@link isMalformedNumericLiteral} never flags
 * it, even though it also fails {@link isCompleteStepNumericLiteral}.
 */
function looksLikeNumericAttempt(token: string): boolean {
  const n = token.length;
  let i = 0;
  if (i < n && (token[i] === '+' || token[i] === '-')) i++;
  if (i >= n) return false;
  const c = token[i];
  if (c >= '0' && c <= '9') return true;
  if (c === '.' && i + 1 < n) {
    const d = token[i + 1];
    return d >= '0' && d <= '9';
  }
  return false;
}

/**
 * True when `raw` is a token the extractor preserved verbatim *because* the
 * number it names overflows the IEEE-754 double range — `1.0E400`.
 *
 * `parseAttributeValue` returns the raw token for anything it cannot represent
 * as a finite number, so a string in a numeric attribute slot is ambiguous: it
 * may be an enumeration, a mis-typed label, or a real the double range cannot
 * hold. Only the last is an *unrepresentable number*, and only that case is
 * this predicate's business. Callers whose value type is `number` refuse
 * rather than substitute a plausible-looking `0`; they go through
 * {@link isUnrepresentableNumericValue}, which adds the non-finite `number`
 * case this one cannot see, and the malformed-literal case
 * {@link isMalformedNumericLiteral} covers.
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

/**
 * True when `raw` is a string that looks like an attempted STEP numeric
 * literal but whose `parseFloat`-consumed prefix does not cover the whole
 * token — `1.52.3` (a dropped comma fuses two reals into one token) or
 * `1.5abc` (trailing garbage `parseFloat` silently discards). Distinct from
 * {@link isOverflowingNumericLiteral}: an overflowing literal like `1.0E400`
 * IS a complete, grammatically valid token, just one the double range cannot
 * hold, so it fails this predicate and is handled by that one instead.
 *
 * A non-numeric enumeration or identifier (`.T.`, `.UNSPECIFIED.`, `*`) never
 * matches: {@link looksLikeNumericAttempt} restricts this to tokens that
 * start like a number was intended.
 */
export function isMalformedNumericLiteral(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  return looksLikeNumericAttempt(trimmed) && !isCompleteStepNumericLiteral(trimmed);
}

/**
 * True when `raw` states a number that cannot be represented — an
 * overflowing token, a malformed one, or an actual non-finite `number`.
 *
 * The last case is not hypothetical. `getNumber` now answers `undefined` for
 * `Infinity`, so every caller that ends in `?? 0` turns a non-finite number
 * into a plausible zero, and {@link isOverflowingNumericLiteral} alone cannot
 * stop it: that predicate only sees strings. The STEP extractor no longer
 * produces non-finite numbers itself, but this helper's callers are also fed
 * by hand-built entity maps, by `IfcPropertySingleValue` nominal values, and
 * by other packages' fixtures — so "the parser cannot make one" is not the
 * same as "one cannot arrive". The malformed case is not hypothetical either:
 * `parseAttributeValue` now preserves `1.52.3` as that raw string rather than
 * truncating it, and this is the check that stops a caller's `getNumber(raw)
 * || 0` from quietly turning it into a zero.
 *
 * Refusal is reserved for a value that is PRESENT and unrepresentable. `null`
 * / `undefined` — a `$` attribute — is ordinary absence, keeps its meaning,
 * and keeps whatever default the caller already had.
 */
export function isUnrepresentableNumericValue(raw: unknown): boolean {
  if (typeof raw === 'number') return !Number.isFinite(raw);
  if (isMalformedNumericLiteral(raw)) return true;
  return isOverflowingNumericLiteral(raw);
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
  // entity map, and `isIndexableExpressId` is the one place that says which
  // integers this toolkit can actually key on (express-id.ts, #3395).
  // `Infinity` names no entity, two ids past 2^53 accumulate to the same
  // double and would resolve to the same wrong entity, an id above 2^32 is
  // never in the index, and `NaN` matches nothing, including itself.
  if (typeof value === 'number') return isIndexableExpressId(value) ? value : undefined;
  if (typeof value === 'string' && value.startsWith('#')) {
    const num = parseInt(value.substring(1));
    if (isIndexableExpressId(num)) return num;
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
