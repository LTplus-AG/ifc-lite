/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `group` rule row (#5226): the group class and the group Name are both
 * editable, and editing one keeps the other. Asserted on what the rendered
 * inputs hand `onChange`, against literal expected rules.
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, type } from '@/test/render.js';
import type { FilterRule } from '@ifc-lite/rules';
import { RULE_KIND_LABEL } from './filter-rule-labels.js';
import { RuleRow } from './SearchModal.filter.editors.js';

afterEach(cleanup);

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

describe('RuleRow — group rule (#5226)', () => {
  it('is offered as a rule kind', () => {
    assert.equal((RULE_KIND_LABEL as Record<string, string>).group, 'Group');
  });

  it('edits the group class and keeps the op', () => {
    const commits: FilterRule[] = [];
    const container = renderRow({ kind: 'group', op: 'isSet', value: '' }, commits);
    const classInput = container.querySelector('input[aria-label^="Group class"]');
    assert.ok(classInput instanceof window.HTMLInputElement, 'no group class input rendered');
    type(classInput, 'IfcSystem');
    assert.deepEqual(commits.at(-1), { kind: 'group', groupClass: 'IfcSystem', op: 'isSet', value: '' });
    assert.equal(container.querySelector('input[placeholder="Group name"]'), null, 'isSet takes no name');
  });

  it('edits the group name and keeps the class and valueKind', () => {
    const commits: FilterRule[] = [];
    const container = renderRow({ kind: 'group', groupClass: 'IfcSystem', op: 'matches', value: 'Supply', valueKind: 'regex' }, commits);
    const nameInput = container.querySelector('input[placeholder="Group name"]');
    assert.ok(nameInput instanceof window.HTMLInputElement, 'no group name input rendered');
    type(nameInput, 'Supply .*');
    assert.deepEqual(commits.at(-1), { kind: 'group', groupClass: 'IfcSystem', op: 'matches', value: 'Supply .*', valueKind: 'regex' });
  });
});
