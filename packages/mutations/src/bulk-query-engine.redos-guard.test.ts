/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `BulkQueryEngine.select`'s `namePattern` criterion compiles a
 * caller-supplied regex live (`new RegExp(criteria.namePattern, 'i')`).
 * Contrary to issue #4259's own claim that this site is "dead from an
 * attacker's perspective" with no shipped caller, `namePattern` IS
 * live: `apps/viewer/src/components/viewer/BulkPropertyEditor.tsx`'s
 * "Name Pattern (Regex)" field sets it directly. This pins that a
 * catastrophic/over-long pattern is rejected (via
 * `@ifc-lite/regex-guard`) instead of hanging, and that an ordinary
 * pattern still matches.
 */

import { describe, expect, it } from 'vitest';
import type { EntityTable } from '@ifc-lite/data';
import { UnsafeRegexPatternError } from '@ifc-lite/regex-guard';
import { BulkQueryEngine } from './bulk-query-engine.js';
import { MutablePropertyView } from './mutable-property-view.js';

/** Minimal EntityTable with just what `select`'s namePattern path reads. */
function makeEntityTable(names: string[]): { table: EntityTable; strings: { get(i: number): string } } {
  const count = names.length;
  const table: EntityTable = {
    count,
    expressId: Uint32Array.from(names.map((_, i) => i + 1)),
    typeEnum: new Uint16Array(count),
    globalId: new Uint32Array(count),
    name: Uint32Array.from(names.map((_, i) => i)), // name index == array index
    description: new Uint32Array(count),
    objectType: new Uint32Array(count),
    flags: new Uint8Array(count),
    containedInStorey: new Int32Array(count).fill(-1),
    definedByType: new Int32Array(count).fill(-1),
    geometryIndex: new Int32Array(count).fill(-1),
    typeRanges: new Map(),
    getGlobalId: () => '',
    getName: (expressId: number) => names[expressId - 1] ?? '',
    getDescription: () => '',
    getObjectType: () => '',
    getTypeName: () => '',
  };
  const strings = { get: (idx: number) => names[idx] ?? '' };
  return { table, strings };
}

describe('BulkQueryEngine.select — namePattern ReDoS guard', () => {
  it('rejects a catastrophic-backtracking namePattern instead of hanging', () => {
    const { table, strings } = makeEntityTable(['Wall-001', 'a'.repeat(35)]);
    const engine = new BulkQueryEngine(
      table,
      new MutablePropertyView(null, 'model-1'),
      null,
      null,
      strings
    );
    const start = performance.now();
    expect(() => engine.select({ namePattern: '(a+)+b' })).toThrow(UnsafeRegexPatternError);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('still matches a legitimate namePattern', () => {
    const { table, strings } = makeEntityTable(['Wall-Exterior-01', 'Slab-01', 'Wall-Interior-02']);
    const engine = new BulkQueryEngine(
      table,
      new MutablePropertyView(null, 'model-1'),
      null,
      null,
      strings
    );
    const matched = engine.select({ namePattern: '^Wall-.*' });
    expect(matched).toEqual([1, 3]);
  });
});
