/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `query.ts` orchestrates `ifc-lite query`, but its logic-bearing work is in
 * a handful of pure helpers: type auto-prefixing, `--where` syntax parsing,
 * value comparison, and the property/quantity-set fallback that applies a
 * parsed filter to entities. `queryCommand` itself needs a real IFC file and
 * a loaded `bim` context (exercised end-to-end elsewhere in the package via
 * other commands' fixtures); these tests target the helpers directly so a
 * mutation is caught without spawning the full CLI pipeline. Each helper
 * gained `export` here (behaviourally a no-op — confirmed against the
 * existing suite and `tsc --noEmit` before use) so it can be tested in
 * isolation, following the pattern already used for `query-aggregation.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeTypeName,
  parseWhereFilter,
  compareValues,
  normalizeBooleanValue,
  applyWhereFilter,
} from './query.js';

describe('normalizeTypeName', () => {
  /**
   * Kills narrowing the prefix check from
   * `startsWith('Ifc') || startsWith('IFC') || startsWith('ifc')` to just
   * `startsWith('Ifc') || startsWith('ifc')`: an all-caps "IFCWALL" would
   * then be treated as unprefixed and get double-prefixed to "IfcIFCWALL".
   */
  it('leaves an already-prefixed type alone regardless of casing', () => {
    expect(normalizeTypeName('IFCWALL')).toBe('IFCWALL');
    expect(normalizeTypeName('IfcWall')).toBe('IfcWall');
    expect(normalizeTypeName('ifcwall')).toBe('ifcwall');
  });

  it('auto-prefixes a bare type name', () => {
    expect(normalizeTypeName('Wall')).toBe('IfcWall');
  });

  it('normalizes each comma-separated type independently', () => {
    expect(normalizeTypeName('Wall,IfcDoor,Slab')).toBe('IfcWall,IfcDoor,IfcSlab');
  });
});

describe('parseWhereFilter', () => {
  /**
   * Kills reordering the operator-scan list to check `'='` before `'!='`:
   * `"Pset.Prop!=5"` would then match the `=` scan first at the `!` position
   * offset by one, splitting the property name as `"Prop!"` and the value as
   * `"5"` instead of parsing operator `!=`.
   */
  it('recognizes != as a single two-character operator, not = with a stray !', () => {
    expect(parseWhereFilter('Pset.Prop!=5')).toEqual({
      psetName: 'Pset',
      propName: 'Prop',
      operator: '!=',
      value: '5',
    });
  });

  it('parses each supported operator', () => {
    expect(parseWhereFilter('Pset.Prop=5')).toEqual({ psetName: 'Pset', propName: 'Prop', operator: '=', value: '5' });
    expect(parseWhereFilter('Pset.Prop>5')).toEqual({ psetName: 'Pset', propName: 'Prop', operator: '>', value: '5' });
    expect(parseWhereFilter('Pset.Prop<5')).toEqual({ psetName: 'Pset', propName: 'Prop', operator: '<', value: '5' });
    expect(parseWhereFilter('Pset.Prop>=5')).toEqual({ psetName: 'Pset', propName: 'Prop', operator: '>=', value: '5' });
    expect(parseWhereFilter('Pset.Prop<=5')).toEqual({ psetName: 'Pset', propName: 'Prop', operator: '<=', value: '5' });
    expect(parseWhereFilter('Pset.Prop~oo')).toEqual({ psetName: 'Pset', propName: 'Prop', operator: 'contains', value: 'oo' });
  });

  it('treats a bare PsetName.PropName as an existence check', () => {
    expect(parseWhereFilter('Pset.Prop')).toEqual({ psetName: 'Pset', propName: 'Prop', operator: 'exists' });
  });
});

describe('normalizeBooleanValue', () => {
  /**
   * Kills dropping the `.T.` / `.F.` (IFC boolean literal) cases from the
   * normalizer: without them, comparing an IFC-native `.T.` attribute
   * against the CLI spelling `true` (via `--where Pset.Prop=true`) would
   * compare the literal strings `".T."` and `"true"` and never match.
   */
  it('normalizes the IFC boolean literal spelling to the same value as the word', () => {
    expect(normalizeBooleanValue('.T.')).toBe(normalizeBooleanValue('true'));
    expect(normalizeBooleanValue('.F.')).toBe(normalizeBooleanValue('false'));
  });

  it('passes non-boolean values through unchanged', () => {
    expect(normalizeBooleanValue('IfcWall')).toBe('IfcWall');
    expect(normalizeBooleanValue(42)).toBe(42);
  });
});

describe('compareValues', () => {
  // `expected` is always the raw string lifted out of the `--where`
  // expression by `parseWhereFilter`, never a number — the numeric operators
  // coerce it themselves. `actual` is the store-side value and really can be
  // a number, so the pairs below are the shapes the command actually feeds in.
  it('supports every operator', () => {
    expect(compareValues('5', '=', '5')).toBe(true);
    expect(compareValues('5', '!=', '6')).toBe(true);
    expect(compareValues(5, '>', '3')).toBe(true);
    expect(compareValues(3, '<', '5')).toBe(true);
    expect(compareValues(5, '>=', '5')).toBe(true);
    expect(compareValues(5, '<=', '5')).toBe(true);
    expect(compareValues('Concrete Wall', 'contains', 'wall')).toBe(true);
  });

  /**
   * Kills loosening `'>='` from `>=` to `>`: an entity whose value exactly
   * equals the threshold would then be excluded by `--where
   * Pset.Prop>=Value`, which is precisely the equal-boundary case `>=` exists
   * to include.
   */
  it('>= includes the exact boundary value', () => {
    expect(compareValues(5, '>=', '5')).toBe(true);
  });
});

describe('applyWhereFilter', () => {
  /**
   * Kills searching the quantity-set fallback by `parsed.propName` instead
   * of `parsed.psetName`: the B3 fallback exists so `--where
   * Qto_WallBaseQuantities.NetVolume>10` matches entities whose property set
   * lookup misses but whose quantity set has the value. Keying the fallback
   * lookup by the wrong field means it can never find the quantity set by
   * name and the fallback silently stops working.
   */
  it('falls back to a quantity set (found by pset name) when no property set matches', () => {
    const bim = {
      properties: () => [],
      quantities: (ref: number) => ({
        1: [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetVolume', value: 15 }] }],
        2: [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetVolume', value: 3 }] }],
      })[ref] ?? [],
    };
    const parsed = parseWhereFilter('Qto_WallBaseQuantities.NetVolume>10');
    const result = applyWhereFilter([{ ref: 1 }, { ref: 2 }], parsed, bim);
    expect(result.map((e) => e.ref)).toEqual([1]);
  });

  it('matches from a property set when present', () => {
    const bim = {
      properties: (ref: number) => ({
        1: [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] }],
      })[ref] ?? [],
      quantities: () => [],
    };
    const parsed = parseWhereFilter('Pset_WallCommon.IsExternal=true');
    const result = applyWhereFilter([{ ref: 1 }], parsed, bim);
    expect(result.map((e) => e.ref)).toEqual([1]);
  });
});
