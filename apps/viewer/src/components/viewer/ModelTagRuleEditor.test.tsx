/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `modelTag` chip in the filter builder (issue #4215): it renders tag
 * NAMES for the ids a rule stores, draws an id with no definition behind it
 * as an unresolved chip with a visible warning (never hides it — that is how
 * the user finds the rule that matches nothing), and commits rules through
 * `RuleRow` exactly like every other kind.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';

installLayout();

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { Rule, type FilterRule } from '@/lib/search/filter-rules';
import type { ModelTag } from '@/lib/model-tags/types';
import { RuleRow } from './SearchModal.filter.editors.js';

const TAGS: ReadonlyMap<string, ModelTag> = new Map([
  ['id-structure', { id: 'id-structure', name: 'Structure' }],
  ['id-arch', { id: 'id-arch', name: 'Architecture' }],
]);

function mount(rule: FilterRule) {
  const commits: FilterRule[] = [];
  const container = render(
    <RuleRow
      rule={rule}
      modelOptions={[]}
      tagOptions={TAGS}
      ifcTypeOptions={[]}
      storeyOptions={[]}
      psetQto={null}
      valueSchema={null}
      onChange={(next) => commits.push(next)}
      onRemove={() => {}}
    />,
  );
  return { container, commits };
}

afterEach(cleanup);

describe('ModelTagRuleEditor (#4215)', () => {
  it('renders names, not ids, for the tags a rule holds', () => {
    const { container } = mount(Rule.modelTag('hasAny', ['id-structure', 'id-arch']));
    const chips = [...container.querySelectorAll('[data-model-tag-chip]')].map((c) => c.textContent?.replace('×', '').trim());
    assert.deepEqual(chips, ['Structure', 'Architecture']);
    assert.ok(!container.textContent?.includes('id-structure'), 'raw ids never appear');
    assert.ok(container.textContent?.includes('has any of'));
  });

  it('draws a deleted tag as an unresolved chip with a warning, and lets the user remove it', () => {
    const { container, commits } = mount(Rule.modelTag('hasNone', ['id-structure', 'id-gone']));
    const broken = container.querySelector<HTMLElement>('[data-unresolved="true"]');
    assert.ok(broken, 'the unresolved id is drawn, not hidden');
    assert.ok(broken.textContent?.includes('Unknown tag'));
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /no longer exists/);

    click(broken.querySelector('button')!);
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0], Rule.modelTag('hasNone', ['id-structure']));
  });

  it('untagged needs no tag list: the picker and chips are gone and the rule stays well-formed', () => {
    const { container } = mount(Rule.modelTag('untagged', []));
    assert.equal(container.querySelector('[aria-label="Pick model tags"]'), null);
    assert.equal(container.querySelectorAll('[data-model-tag-chip]').length, 0);
    assert.ok(container.textContent?.includes('is untagged'));
  });
});
