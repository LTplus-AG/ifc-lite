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
import { act } from 'react';

installLayout();

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { Rule } from '@/lib/search/filter-rules';
import type { ClashSetFilter } from '@/lib/clash/set-filter';
import { ClashSetFilterEditor } from './ClashSetFilterEditor.js';
import { RuleRow } from './SearchModal.filter.editors.js';

const TWO_RULES: ClashSetFilter = {
  combinator: 'AND',
  rules: [Rule.ifcType(['IfcWall']), Rule.name('contains', 'EXT')],
};

function mount(filter: ClashSetFilter | undefined) {
  const commits: Array<ClashSetFilter | undefined> = [];
  const container = render(
    <ClashSetFilterEditor label="Set A" filter={filter} onChange={(next) => commits.push(next)} />,
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
    const { container, commits } = mount({ combinator: 'AND', rules: [Rule.ifcType(['IfcWall'])] });
    click(buttonByText(container, 'Clear'));
    assert.deepEqual(commits, [undefined]);
  });

  it('switches the combinator without disturbing the rules', () => {
    const { container, commits } = mount(TWO_RULES);
    click(buttonByText(container, 'OR'));
    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.combinator, 'OR');
    assert.deepEqual(commits[0]?.rules, TWO_RULES.rules);
  });

  it('offers no combinator or clear control when there is no filter yet', () => {
    const { container } = mount(undefined);
    const labels = [...container.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
    assert.ok(!labels.includes('AND'), 'a single-rule-less side has nothing to combine');
    assert.ok(!labels.includes('Clear'));
    assert.ok(labels.some((l) => l.includes('Add filter rule')));
  });

  it('shows model names and commits the selected durable source identity (#4019)', () => {
    const commits: Array<ReturnType<typeof Rule.model>> = [];
    const container = render(
      <RuleRow
        rule={Rule.model([])}
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
    assert.deepEqual(commits, [Rule.model(['Structure.ifc:fingerprint-b'])]);
  });
});
