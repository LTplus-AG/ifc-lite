/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The clash set filter editor commits what the resolver reads (#3902).
 *
 * The invariant worth a mounted test is the EMPTY one: a side whose last rule
 * the user removed must commit `undefined` — no filter — because an empty
 * filter would resolve to an empty member set and silently run that side over
 * nothing (`lib/clash/set-filter.ts`). Asserted by clicking the rendered
 * controls and reading what `onChange` was handed.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { act, useState } from 'react';

installLayout();

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { Rule } from '@ifc-lite/rules';
import type { ClashSetFilter } from '@/lib/clash/set-filter';
import { ClashSetFilterEditor } from './ClashSetFilterEditor.js';
import { RuleRow } from './SearchModal.filter.editors.js';

const TWO_RULES: ClashSetFilter = [{
  combinator: 'AND',
  rules: [Rule.ifcType(['IfcWall']), Rule.name('contains', 'EXT')],
}];

function mount(filter: ClashSetFilter | undefined) {
  const commits: Array<ClashSetFilter | undefined> = [];
  function Harness() {
    const [value, setValue] = useState(filter);
    return <ClashSetFilterEditor label="Set A" filter={value} onChange={(update) => setValue((previous) => {
      const next = update(previous);
      commits.push(next);
      return next;
    })} />;
  }
  const container = render(
    <Harness />,
  );
  return { container, commits };
}

function buttonByText(container: HTMLElement, text: string): HTMLElement {
  const hit = [...container.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === text,
  );
  assert.ok(hit, `no button labelled "${text}" — controls: ${[...container.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`);
  return hit as HTMLElement;
}

afterEach(cleanup);

describe('ClashSetFilterEditor', () => {
  it('renders one row per rule', () => {
    const { container } = mount(TWO_RULES);
    const labels = [...container.querySelectorAll('span')]
      .map((s) => (s.textContent ?? '').trim())
      .filter((t) => t === 'IFC Type' || t === 'Name');
    assert.deepEqual(labels, ['IFC Type', 'Name']);
  });

  it('commits UNDEFINED, not an empty filter, when the last rule is cleared', () => {
    const { container, commits } = mount([{ combinator: 'AND', rules: [Rule.ifcType(['IfcWall'])] }]);
    click(buttonByText(container, 'Clear'));
    assert.deepEqual(commits, [undefined]);
  });

  it('switches the combinator without disturbing the rules', () => {
    const { container, commits } = mount(TWO_RULES);
    click(buttonByText(container, 'OR'));
    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.[0]?.combinator, 'OR');
    assert.deepEqual(commits[0]?.[0]?.rules, TWO_RULES[0].rules);
  });

  it('adds a second OR group through the shared editor and keeps the first group (#5898)', () => {
    const { container, commits } = mount(TWO_RULES);
    click(buttonByText(container, 'Add group'));
    assert.deepEqual(commits[0], [TWO_RULES[0], { combinator: 'AND', rules: [] }]);
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim());
    assert.deepEqual(tabs, ['Group 1(2)', 'Group 2(0)']);
  });

  it('offers no combinator or clear control when there is no filter yet', () => {
    const { container } = mount(undefined);
    const labels = [...container.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
    assert.ok(!labels.includes('Clear'));
    assert.ok(labels.some((l) => l.includes('Add rule')));
  });

  it('shows model names and commits the selected durable source identity (#4019)', () => {
    type ModelRule = ReturnType<typeof Rule.model>;
    const commits: ModelRule[] = [];
    const container = render(
      <RuleRow
        rule={Rule.model([])}
        tagOptions={new Map()}
        modelOptions={[
          { label: 'Architecture.ifc', value: 'Architecture.ifc:fingerprint-a' },
          { label: 'Structure.ifc', value: 'Structure.ifc:fingerprint-b' },
        ]}
        ifcTypeOptions={[]}
        storeyOptions={[]}
        psetQto={null}
        valueSchema={null}
        onChange={(next) => {
          if (next.kind === 'model') commits.push(next);
        }}
        onRemove={() => {}}
      />,
    );

    const trigger = buttonByText(container, 'Pick values…');
    act(() => {
      trigger.dispatchEvent(new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }));
    });
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes('Structure.ifc'));
    assert.ok(option, 'the model picker must display the loaded model name');
    click(option);
    assert.deepEqual(commits, [{
      kind: 'model',
      values: ['Structure.ifc:fingerprint-b'],
      op: 'in',
    }]);
  });
});
