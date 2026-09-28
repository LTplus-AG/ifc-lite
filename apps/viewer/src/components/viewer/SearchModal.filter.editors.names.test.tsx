/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, type } from '@/test/render.js';
import type { FilterRule } from '@ifc-lite/rules';
import { RuleRow } from './SearchModal.filter.editors.js';

function renderRow(rule: FilterRule, commits: FilterRule[]): HTMLElement {
  return render(
    <RuleRow
      rule={rule}
      tagOptions={new Map()}
      modelOptions={[]}
      ifcTypeOptions={[]}
      storeyOptions={[]}
      psetQto={null}
      valueSchema={null}
      onChange={(next) => commits.push(next)}
      onRemove={() => {}}
    />,
  );
}

describe('Search rule editor input names (#6342)', () => {
  afterEach(cleanup);

  it('distinguishes names and values across rule kinds after placeholders disappear', () => {
    const cases: Array<{ rule: FilterRule; names: string[] }> = [
      { rule: { kind: 'predefinedType', op: 'in', values: [] }, names: ['Predefined types'] },
      { rule: { kind: 'name', op: 'contains', value: 'Wall' }, names: ['Name value'] },
      { rule: { kind: 'type', op: 'contains', value: 'Wall' }, names: ['Type name value'] },
      { rule: { kind: 'parent', op: 'contains', value: 'Wall' }, names: ['Parent name value'] },
      { rule: { kind: 'property', setName: 'Pset_WallCommon', propertyName: 'FireRating', op: 'eq', value: 'REI60' }, names: ['Property set name', 'Property name', 'Property value', 'Complex property member'] },
      { rule: { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width', op: 'gt', value: 1 }, names: ['Quantity set name', 'Quantity name', 'Quantity value'] },
      { rule: { kind: 'material', op: 'contains', value: 'Concrete' }, names: ['Material name'] },
      { rule: { kind: 'elevation', op: 'gt', value: 1 }, names: ['Storey elevation in metres'] },
    ];
    for (const { rule, names } of cases) {
      const container = renderRow(rule, []);
      const actual = [...container.querySelectorAll('input')].map((input) => input.getAttribute('aria-label'));
      assert.deepEqual(actual, names, `${rule.kind} input names`);
      cleanup();
    }
  });

  it('edits the named quantity value while keeping the set and quantity', () => {
    const commits: FilterRule[] = [];
    const rule: FilterRule = { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width', op: 'gt', value: 1 };
    const container = renderRow(rule, commits);
    const value = container.querySelector('input[aria-label="Quantity value"]');
    assert.ok(value instanceof window.HTMLInputElement);
    type(value, '2');
    assert.deepEqual(commits.at(-1), { ...rule, value: 2 });
  });
});
