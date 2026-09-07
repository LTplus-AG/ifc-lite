/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selector field, driven the way a user drives it (#4091): type into the
 * real input, press the real button, read the store back.
 *
 * The assertions are on the OUTPUT — the rules that land in `searchFilter` and
 * the text that appears — never on the component merely being mounted. A field
 * wired to a handler nothing reaches renders identically, and #4091 is exactly
 * a case of something looking like it worked while doing nothing.
 */

import '@/test/setup-dom.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, type, press } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { Rule } from '@/lib/search/filter-rules';
import { SearchModalFilterSelector } from './SearchModal.filter.selector.js';

const WALLS = ['IfcWall', 'IfcWallElementedCase', 'IfcWallStandardCase'];

function mount(): HTMLElement {
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m1'), schemaVersion: 'IFC4' }),
    searchFilter: { rules: [], combinator: 'AND', limit: 500 },
  });
  return render(<SearchModalFilterSelector />);
}

function field(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input[aria-label="Selector syntax"]');
  assert.ok(el instanceof window.HTMLInputElement, 'no selector input rendered');
  return el;
}

function applyButton(container: HTMLElement): Element {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Apply'));
  assert.ok(el, 'no Apply button rendered');
  return el;
}

const rulesInStore = () => useViewerStore.getState().searchFilter.rules;
const alertText = (container: HTMLElement) => container.querySelector('[role="alert"]')?.textContent ?? '';

describe('SearchModalFilterSelector', () => {
  beforeEach(() => {
    useViewerStore.setState({ searchFilter: { rules: [], combinator: 'AND', limit: 500 } });
  });
  afterEach(cleanup);

  it('applying a selector replaces the rule list with what it means', () => {
    const container = mount();
    type(field(container), 'IfcWall, Name=/W.*/');
    click(applyButton(container));

    assert.deepEqual(rulesInStore(), [Rule.ifcType(WALLS, 'in'), Rule.name('matches', 'W.*')]);
    assert.equal(useViewerStore.getState().searchFilter.combinator, 'AND');
    assert.equal(alertText(container), '');
  });

  it('Enter applies it too', () => {
    const container = mount();
    const input = field(container);
    type(input, 'IfcDoor');
    press(input, 'Enter');
    assert.deepEqual(rulesInStore(), [Rule.ifcType(['IfcDoor', 'IfcDoorStandardCase'], 'in')]);
  });

  it('a parse error applies NOTHING and says where it broke', () => {
    const container = mount();
    // The reported symptom: `IfcWall` found 15 elements and `IfcWall*` found 0.
    type(field(container), 'IfcWall*');
    click(applyButton(container));

    assert.deepEqual(rulesInStore(), []);
    const message = alertText(container);
    assert.match(message, /Character 8/);
    assert.match(message, /\*=/);
  });

  it('a selector with an unsupported part applies the rest AND names what it dropped', () => {
    const container = mount();
    type(field(container), 'IfcWall, type=WT01');
    click(applyButton(container));

    assert.deepEqual(rulesInStore(), [Rule.ifcType(WALLS, 'in')]);
    assert.match(alertText(container), /type=WT01/);
  });

  it('a selector that maps to no rule at all applies nothing and explains', () => {
    const container = mount();
    type(field(container), 'query:types.count=0');
    click(applyButton(container));

    assert.deepEqual(rulesInStore(), []);
    assert.match(alertText(container), /query:types\.count=0/);
  });

  it('a successful apply clears a previous complaint', () => {
    const container = mount();
    type(field(container), 'IfcWall, type=WT01');
    click(applyButton(container));
    assert.notEqual(alertText(container), '');

    type(field(container), 'IfcWall');
    click(applyButton(container));
    assert.equal(alertText(container), '');
    assert.deepEqual(rulesInStore(), [Rule.ifcType(WALLS, 'in')]);
  });

  it('an empty field does nothing at all', () => {
    const container = mount();
    useViewerStore.setState({ searchFilter: { rules: [Rule.name('eq', 'keep me')], combinator: 'OR', limit: 500 } });
    press(field(container), 'Enter');
    assert.deepEqual(rulesInStore(), [Rule.name('eq', 'keep me')]);
  });
});
