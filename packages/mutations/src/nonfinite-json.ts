/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `JSON.stringify`/`JSON.parse` replacer+reviver pair that preserves a
 * non-finite number (`NaN`/`Infinity`/`-Infinity`) inside a `Mutation`'s
 * `newValue`/`oldValue`, or a `value` inside a whole-set `newValue` array
 * (`createPropertySet`/`createQuantitySet`'s per-member payload).
 *
 * JSON has no non-finite numeric literal (RFC 8259); `JSON.stringify` silently
 * maps `NaN`/`Infinity`/`-Infinity` to `null`, indistinguishable from the value
 * being absent. `MutablePropertyView.applyMutations`' quantity replay then
 * does `Number(mutation.newValue)`, and `Number(null)` is `0` — so an
 * out-of-range quantity (e.g. a computed volume that overflowed, or a CSV
 * cell parsed to `NaN`) silently became `0` across `exportMutations()` →
 * `importMutations()`, even though direct application (no serialization in
 * between) preserves it exactly. Mirrors the sibling fix for the JSON/JSON-LD
 * export path (`finite_json_number` in `rust/export/src/json.rs`, #3596) and
 * the query aggregation guard (#3611) — this repo's recurring non-finite-value
 * shape.
 */
const NON_FINITE_NUMBER_KEYS = new Set(['newValue', 'oldValue', 'value']);

interface NonFiniteNumberMarker {
  __nonFiniteNumber: 'NaN' | 'Infinity' | '-Infinity';
}

function isNonFiniteNumberMarker(value: unknown): value is NonFiniteNumberMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { __nonFiniteNumber?: unknown }).__nonFiniteNumber === 'string'
  );
}

/** `JSON.stringify` replacer for `MutablePropertyView.exportMutations()`. */
export function encodeNonFiniteNumbers(key: string, value: unknown): unknown {
  if (NON_FINITE_NUMBER_KEYS.has(key) && typeof value === 'number' && !Number.isFinite(value)) {
    const token: NonFiniteNumberMarker['__nonFiniteNumber'] = Number.isNaN(value)
      ? 'NaN'
      : value > 0
        ? 'Infinity'
        : '-Infinity';
    return { __nonFiniteNumber: token } satisfies NonFiniteNumberMarker;
  }
  return value;
}

/**
 * `JSON.parse` reviver for `MutablePropertyView.importMutations()`; inverse
 * of {@link encodeNonFiniteNumbers}.
 */
export function decodeNonFiniteNumbers(key: string, value: unknown): unknown {
  if (NON_FINITE_NUMBER_KEYS.has(key) && isNonFiniteNumberMarker(value)) {
    switch (value.__nonFiniteNumber) {
      case 'NaN':
        return NaN;
      case 'Infinity':
        return Infinity;
      case '-Infinity':
        return -Infinity;
    }
  }
  return value;
}
