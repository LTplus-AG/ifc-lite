/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A `where(...)` / `--where` predicate needs to compare a stored property or
 * quantity value against a caller-supplied filter value. Three call sites
 * implemented this independently (the CLI's `HeadlessBackend`, the MCP
 * backend, and the `ifc-lite query --where` flag), and a fourth — the
 * viewer's embedded SDK backend, `bim`'s primary consumption path — never
 * picked up the boolean-normalization/case-insensitive-`contains` fix the
 * other three carry, so the identical `bim.query().where(...)` call silently
 * matched fewer rows there than in the CLI/MCP. This module is the single
 * home for that comparison so the four call sites can't drift apart again.
 */

export type FilterComparisonOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'exists';

/**
 * Normalize boolean-like values for comparison. IFC STEP encodes booleans as
 * `.T.`/`.F.` tokens; parsed property values are typically real JS booleans
 * by the time they reach a filter, but a caller-supplied filter value (a CLI
 * flag, a raw mutation) may arrive as one of the string spellings instead.
 * Collapsing every spelling to the same `'true'`/`'false'` string lets the
 * `String(a) === String(b)` comparisons below treat them all as equal.
 */
export function normalizeBooleanValue(value: unknown): unknown {
  if (value === true || value === '.T.' || value === 'true' || value === 'TRUE') return 'true';
  if (value === false || value === '.F.' || value === 'false' || value === 'FALSE') return 'false';
  return value;
}

/**
 * Evaluate a single comparison operator against a stored value and a
 * filter value. Booleans are normalized first (see {@link normalizeBooleanValue}),
 * and `contains` is case-insensitive — the settled semantics across the
 * CLI/MCP query backends, now shared rather than duplicated.
 *
 * `exists` answers "is this property/quantity present", not "does it carry a
 * non-null value" — a caller passes `actual` here only once it has already
 * confirmed the property was found (e.g. `IFCPROPERTYSINGLEVALUE('FireRating',
 * $,$,$)` is present in its pset with a `$` nominal value, which parses to
 * `null`; it still exists). So `exists` is unconditional true once reached.
 */
export function compareFilterValue(actual: unknown, operator: FilterComparisonOp, expected: unknown): boolean {
  if (operator === 'exists') return true;
  const normActual = normalizeBooleanValue(actual);
  const normExpected = normalizeBooleanValue(expected);
  switch (operator) {
    case '=': return String(normActual) === String(normExpected);
    case '!=': return String(normActual) !== String(normExpected);
    case '>': return Number(normActual) > Number(normExpected);
    case '<': return Number(normActual) < Number(normExpected);
    case '>=': return Number(normActual) >= Number(normExpected);
    case '<=': return Number(normActual) <= Number(normExpected);
    case 'contains': return String(normActual).toLowerCase().includes(String(normExpected).toLowerCase());
    default: return false;
  }
}
