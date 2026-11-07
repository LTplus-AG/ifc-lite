/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `customGrouping` chip (#8425), mounted through `RuleRow` like every
 * host mounts it. The groupings come from the store's saved Lenses: only
 * rule-based ones are offered, picking one records its id and name, and an
 * unknown grouping or group is announced rather than hidden.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { act } from 'react';

installLayout();

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { Rule, type FilterRule } from '@ifc-lite/rules';
import type { Lens } from '@ifc-lite/lens';
import { useViewerStore } from '@/store';
import { RuleRow } from './SearchModal.filter.editors.js';
import { blankRuleOfKind } from './FilterRuleControls.js';

const lensRule = (id: string, name: string) => ({ id, name, enabled: true, groups: [], action: 'colorize' as const, color: '#000000' });
const LENSES: Lens[] = [
  { id: 'lens-disc', name: 'Disciplines', rules: [lensRule('a', 'Structure'), lensRule('b', 'Architecture'), lensRule('c', 'structure')] },
  { id: 'lens-auto', name: 'By class', rules: [], autoColor: { source: 'ifcType' } },
];

function mount(rule: FilterRule) {
  const commits: FilterRule[] = [];
  const container = render(
    <RuleRow
      rule={rule}
      modelOptions={[]}
      tagOptions={new Map()}
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

/** Radix opens its menus on pointerdown (a following click would toggle it shut) and portals the items to `document.body`. */
function openMenu(trigger: Element): HTMLElement[] {
  act(() => { trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })); });
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

let saved: Lens[];
beforeEach(() => { saved = useViewerStore.getState().savedLenses; useViewerStore.setState({ savedLenses: LENSES }); });
afterEach(() => { cleanup(); useViewerStore.setState({ savedLenses: saved }); });

describe('CustomGroupingRuleEditor (#8425)', () => {
  it('offers rule-based Lenses only, and picking one records its id and name', () => {
    const { container, commits } = mount(blankRuleOfKind('customGrouping'));
    const items = openMenu(container.querySelector('[aria-label="Pick a custom grouping"]')!);
    assert.deepEqual(items.map((i) => i.textContent?.trim()), ['Disciplines']);
    click(items[0]);
    assert.deepEqual(commits.at(-1), Rule.customGrouping({ id: 'lens-disc', name: 'Disciplines' }, 'in', []));
  });

  it('lists each group name once and toggles it into the rule', () => {
    const { container, commits } = mount(Rule.customGrouping({ id: 'lens-disc', name: 'Disciplines' }, 'in', []));
    const items = openMenu([...container.querySelectorAll('button')].find((b) => b.textContent === 'Pick values…')!);
    assert.deepEqual(items.map((i) => i.textContent?.trim()), ['Structure', 'Architecture']);
    click(items[1]);
    assert.deepEqual(commits.at(-1), Rule.customGrouping({ id: 'lens-disc', name: 'Disciplines' }, 'in', ['Architecture']));
  });

  it('shows a renamed grouping by its current name, resolved through the id', () => {
    const { container } = mount(Rule.customGrouping({ id: 'lens-disc', name: 'Old name' }, 'in', ['Structure']));
    assert.equal(container.querySelector('[aria-label="Pick a custom grouping"]')?.textContent, 'Disciplines');
    assert.equal(container.querySelector('[role="alert"]'), null);
  });

  it('announces an unknown grouping and an unknown group', () => {
    assert.match(mount(Rule.customGrouping({ name: 'Trades' }, 'in', ['Structure'])).container.querySelector('[role="alert"]')?.textContent ?? '',
      /"Trades" does not exist here/);
    cleanup();
    assert.match(mount(Rule.customGrouping({ name: 'Disciplines' }, 'in', ['MEP'])).container.querySelector('[role="alert"]')?.textContent ?? '',
      /The group MEP is not in this grouping/);
  });
});
