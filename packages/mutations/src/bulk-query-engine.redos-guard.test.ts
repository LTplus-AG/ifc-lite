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
import { EntityTableBuilder, StringTable } from '@ifc-lite/data';
import { UnsafeRegexPatternError } from '@ifc-lite/regex-guard';
import { BulkQueryEngine } from './bulk-query-engine.js';
import { MutablePropertyView } from './mutable-property-view.js';

/** #4366: use canonical columns/getters so this fixture obeys the real table contract. */
function makeEntityTable(names: string[]) {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(names.length, strings);
  names.forEach((name, index) => builder.add(index + 1, 'IFCWALL', `fixture-${index}`, name, '', ''));
  return { table: builder.build(), strings };
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
