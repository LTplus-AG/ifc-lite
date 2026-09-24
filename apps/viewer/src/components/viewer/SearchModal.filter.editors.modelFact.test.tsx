/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `modelFact` rule row (#5442): offered as a kind, every fact is
 * selectable, and changing the fact keeps the op and value.
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { MODEL_FACTS, type FilterRule } from '@ifc-lite/rules';
import { render, cleanup } from '@/test/render.js';
import { RULE_KIND_LABEL } from './filter-rule-labels.js';
import { blankRuleOfKind } from './FilterRuleControls.js';
import { RuleRow } from './SearchModal.filter.editors.js';

afterEach(cleanup);

describe('RuleRow — model fact rule (#5442)', () => {
  it('is offered as a kind and starts as "georef.crs is set"', () => {
    assert.equal((RULE_KIND_LABEL as Record<string, string>).modelFact, 'Model fact');
    assert.deepEqual(blankRuleOfKind('modelFact'), { kind: 'modelFact', fact: 'georef.crs', op: 'isSet', value: '' });
  });

  it('offers every fact and keeps op and value when the fact changes', () => {
    const commits: FilterRule[] = [];
    const rule: FilterRule = { kind: 'modelFact', fact: 'units.length', op: 'eq', value: 'mm' };
    const container = render(
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
    const select = container.querySelector('select[aria-label="Fact about the element\'s model"]');
    assert.ok(select instanceof window.HTMLSelectElement, 'no fact selector rendered');
    assert.deepEqual([...select.options].map((o) => o.value), [...MODEL_FACTS]);
    act(() => {
      select.value = 'units.area';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.deepEqual(commits.at(-1), { ...rule, fact: 'units.area' });
  });
});
