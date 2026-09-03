/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { compareFilterValue, normalizeBooleanValue } from './filter-predicate.js';
import { findAllPropertiesInSets } from './pset-lookup.js';

describe('normalizeBooleanValue', () => {
  it('collapses every true-spelling to the same string', () => {
    expect(normalizeBooleanValue(true)).toBe('true');
    expect(normalizeBooleanValue('.T.')).toBe('true');
    expect(normalizeBooleanValue('true')).toBe('true');
    expect(normalizeBooleanValue('TRUE')).toBe('true');
  });

  it('collapses every false-spelling to the same string', () => {
    expect(normalizeBooleanValue(false)).toBe('false');
    expect(normalizeBooleanValue('.F.')).toBe('false');
    expect(normalizeBooleanValue('false')).toBe('false');
    expect(normalizeBooleanValue('FALSE')).toBe('false');
  });

  it('passes non-boolean values through unchanged', () => {
    expect(normalizeBooleanValue('IfcWall')).toBe('IfcWall');
    expect(normalizeBooleanValue(42)).toBe(42);
    expect(normalizeBooleanValue(null)).toBe(null);
  });
});

describe('compareFilterValue', () => {
  it('exists matches once the property was found, regardless of its value', () => {
    // A `where(pset, prop, 'exists')` caller only reaches `compareFilterValue`
    // after already confirming the property/quantity was present (see the
    // three `QueryBackendMethods` call sites, all guarded by a presence
    // check before this runs) — so `exists` here answers "was it found",
    // not "does it also carry a non-null value". An IFC
    // `IFCPROPERTYSINGLEVALUE('FireRating',$,$,$)` — a `$` nominal value,
    // which parses to `null` — genuinely exists in its pset.
    expect(compareFilterValue('REI60', 'exists', undefined)).toBe(true);
    expect(compareFilterValue(null, 'exists', undefined)).toBe(true);
  });

  it('= treats .T./true/TRUE as equal', () => {
    expect(compareFilterValue(true, '=', '.T.')).toBe(true);
    expect(compareFilterValue('.F.', '=', false)).toBe(true);
  });

  it('contains is case-insensitive', () => {
    expect(compareFilterValue('REI60', 'contains', 'rei')).toBe(true);
    expect(compareFilterValue('rei60', 'contains', 'REI')).toBe(true);
    expect(compareFilterValue('REI60', 'contains', 'xyz')).toBe(false);
  });

  it('numeric comparisons coerce both sides', () => {
    expect(compareFilterValue(5, '>', '3')).toBe(true);
    expect(compareFilterValue('2', '<', 3)).toBe(true);
  });
});

/**
 * `HeadlessBackend.query.entities()`, the MCP `backend-query.ts` handler,
 * and the viewer's `query-adapter.ts` all apply a property filter the same
 * way: find every same-named property across every same-named pset, then
 * (a) an `exists` filter matches as soon as one was found, value aside, and
 * (b) every other operator matches if ANY of the found properties satisfies
 * it (#3490 — a same-named pset can appear twice on one entity, e.g. type +
 * occurrence). This helper reproduces that exact shape so a future
 * divergence between the three call sites and this test is loud — see
 * `packages/cli/src/headless-backend.ts`, `packages/mcp/src/backend-query.ts`
 * and `apps/viewer/src/sdk/adapters/query-adapter.ts` for the real call
 * sites this mirrors.
 */
interface TestProp {
  readonly name: string;
  readonly value: unknown;
}
interface TestPset {
  readonly name: string;
  readonly properties: readonly TestProp[];
}

function applyBackendFilter(
  psets: readonly TestPset[],
  psetName: string,
  propName: string,
  operator: import('./filter-predicate.js').FilterComparisonOp,
  value: unknown,
): boolean {
  const matchingProps = findAllPropertiesInSets(psets, psetName, propName);
  if (matchingProps.length === 0) return false;
  if (operator === 'exists') return true;
  return matchingProps.some((prop) => compareFilterValue(prop.value, operator, value));
}

describe('backend filter-predicate agreement (CLI/MCP/viewer shared shape)', () => {
  it('exists matches a property present with a `$` (null) nominal value', () => {
    // `IFCPROPERTYSINGLEVALUE('FireRating',$,$,$)`: present in its pset,
    // no value set. `parsePropertyValue` returns `null` for the `$`
    // nominal value and still pushes the property.
    const psets: TestPset[] = [
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: null }] },
    ];
    expect(applyBackendFilter(psets, 'Pset_WallCommon', 'FireRating', 'exists', undefined)).toBe(true);
  });

  it('exists does not match when the property is absent entirely', () => {
    const psets: TestPset[] = [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] }];
    expect(applyBackendFilter(psets, 'Pset_WallCommon', 'FireRating', 'exists', undefined)).toBe(false);
  });

  it('any-match: `=` passes when the SECOND same-named pset satisfies it, not just the first', () => {
    const psets: TestPset[] = [
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI30' }] },
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI60' }] },
    ];
    expect(applyBackendFilter(psets, 'Pset_WallCommon', 'FireRating', '=', 'REI60')).toBe(true);
  });

  it('any-match: `=` fails when NO same-named pset satisfies it', () => {
    const psets: TestPset[] = [
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI30' }] },
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI60' }] },
    ];
    expect(applyBackendFilter(psets, 'Pset_WallCommon', 'FireRating', '=', 'REI90')).toBe(false);
  });
});
