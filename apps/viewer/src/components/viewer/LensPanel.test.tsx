/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RuleEditor } from './LensPanel.js';
import type { LensRule } from '@/store/slices/lensSlice';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function render(el: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
  });
  mounted.push({ root, container });
  return container;
}

/** A compound AND rule — reachable only via JSON import, not the panel's own
 *  authoring UI (which only ever produces leaf criteria types). */
function compoundRule(): LensRule {
  return {
    id: 'rule-and',
    name: 'AND rule',
    enabled: true,
    criteria: {
      type: 'and',
      conditions: [
        { type: 'ifcType', ifcType: 'IfcWall' },
        { type: 'property', propertySet: 'Pset_WallCommon', propertyName: 'FireRating', operator: 'gte', propertyValue: '60' },
      ],
    },
    action: 'colorize',
    color: '#123456',
  };
}

function leafRule(): LensRule {
  return {
    id: 'rule-leaf',
    name: 'Walls',
    enabled: true,
    criteria: { type: 'ifcType', ifcType: 'IfcWall' },
    action: 'colorize',
    color: '#654321',
  };
}

const noop = () => {};

describe('RuleEditor — compound criteria safety (does not author compounds, must not destroy an imported one)', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => { root.unmount(); });
      container.remove();
    }
  });

  it('renders a compound rule\'s criteria-type selector DISABLED with only its own type offered — no leaf types to accidentally select', () => {
    const onChange = mock.fn();
    const container = render(
      <RuleEditor
        rule={compoundRule()}
        index={0}
        onChange={onChange}
        onRemove={noop}
        onDuplicate={noop}
        discovered={null}
        onRequestDiscovery={noop}
      />,
    );

    const select = container.querySelector('select') as HTMLSelectElement | null;
    assert.ok(select, 'a criteria-type select must render');
    assert.equal(select!.disabled, true, 'the type selector must be disabled for a compound criteria');
    const options = [...select!.options].map((o) => o.value);
    assert.deepEqual(options, ['and'], 'no leaf criteria type must be offered as an option for a compound rule');
  });

  it('renders a leaf rule\'s selector ENABLED with all leaf types offered (bounding: no behavior change for leaves)', () => {
    const onChange = mock.fn();
    const container = render(
      <RuleEditor
        rule={leafRule()}
        index={0}
        onChange={onChange}
        onRemove={noop}
        onDuplicate={noop}
        discovered={null}
        onRequestDiscovery={noop}
      />,
    );

    const select = container.querySelector('select') as HTMLSelectElement | null;
    assert.ok(select, 'a criteria-type select must render');
    assert.equal(select!.disabled, false, 'a leaf rule\'s type selector must stay interactive');
    const options = [...select!.options].map((o) => o.value);
    assert.ok(options.includes('ifcType') && options.includes('attribute') && options.includes('material'),
      'all leaf criteria types must still be offered for a leaf rule');
  });

  it('shows a read-only "AND — N conditions" summary for a compound rule instead of a leaf editor', () => {
    const container = render(
      <RuleEditor
        rule={compoundRule()}
        index={0}
        onChange={mock.fn()}
        onRemove={noop}
        onDuplicate={noop}
        discovered={null}
        onRequestDiscovery={noop}
      />,
    );

    assert.ok(container.textContent?.includes('AND — 2 conditions'), 'the compound summary label must render');
    // None of the leaf-only editors (IFC class searchable select, attribute
    // name/value inputs, etc.) may render for a compound criteria.
    assert.equal(container.querySelector('input[placeholder="Class..."]'), null);
    assert.equal(container.querySelector('input[placeholder="value..."]'), null);
  });

  it('never calls onChange with a leaf-shaped criteria for a compound rule — the aliased "select any option to destroy the rule" path is gone', () => {
    const onChange = mock.fn();
    const container = render(
      <RuleEditor
        rule={compoundRule()}
        index={0}
        onChange={onChange}
        onRemove={noop}
        onDuplicate={noop}
        discovered={null}
        onRequestDiscovery={noop}
      />,
    );

    const select = container.querySelector('select') as HTMLSelectElement;
    // Even a programmatic change event (bypassing the `disabled` attribute,
    // as a determined test or a buggy future refactor might) must not be
    // able to select a leaf type: the compound branch renders exactly one
    // option (its own type), so there is nothing else to select into.
    act(() => {
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(onChange.mock.callCount(), 0, 'no leaf-rewriting onChange call must fire for a compound rule\'s type selector');
  });
});
