/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Filter builder's group UI (#4904), driven the way a user drives it:
 * click "Add group", add a rule to each group, read the store and the
 * on-screen selector-text readback back. Mirrors
 * `SearchModal.filter.selector.test.tsx` and `SearchModal.filter.promote.test.tsx`
 * — real DOM, real store, assertions on OUTPUT rather than "the component
 * mounted".
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, mouseDown, press, advance } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { emptyFilterState } from '@/store/slices/searchSlice';
import { SearchModalFilterBuilder } from './SearchModal.filter.builder.js';

function mount(): HTMLElement {
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m1'), schemaVersion: 'IFC4' }),
    searchQuery: '',
    searchFilter: emptyFilterState(),
    searchFilterActiveGroup: 0,
  });
  return render(<SearchModalFilterBuilder />);
}

function buttonNamed(container: HTMLElement, text: string): Element {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  assert.ok(el, `no "${text}" button rendered`);
  return el;
}

describe('SearchModalFilterBuilder — groups (#4904)', () => {
  afterEach(cleanup);

  it('starts with one group and no "Add group" tabs row (nothing to switch between yet)', () => {
    const container = mount();
    assert.equal(useViewerStore.getState().searchFilter.groups.length, 1);
    assert.equal(container.querySelector('[role="tablist"]'), null);
  });

  it('"Add group" appends a second AND group and makes it active', () => {
    const container = mount();
    click(buttonNamed(container, 'Add group'));

    const state = useViewerStore.getState();
    assert.equal(state.searchFilter.groups.length, 2);
    assert.deepEqual(state.searchFilter.groups[1], { rules: [], combinator: 'AND' });
    assert.equal(state.searchFilterActiveGroup, 1);

    // The tabs row now exists, with a "+" divider between the two groups —
    // the same character the selector's `+` union syntax uses.
    const tabs = container.querySelector('[role="tablist"]');
    assert.ok(tabs, 'group tabs did not render for a 2-group filter');
    assert.match(tabs?.textContent ?? '', /\+/);
  });

  it('a rule added after "Add group" lands in the NEW group, not group 0', () => {
    const container = mount();
    // Rule content isn't this test's concern (the dropdown menu that adds
    // one is covered by FilterRuleControls' own tests); what matters here
    // is which GROUP `addFilterRule` targets after the UI switches groups —
    // driven through the real "Add group" click, not by hand-setting
    // `searchFilterActiveGroup`.
    useViewerStore.getState().addFilterRule({ kind: 'ifcType', values: ['IfcWall'], op: 'in' });
    click(buttonNamed(container, 'Add group'));
    useViewerStore.getState().addFilterRule({ kind: 'ifcType', values: ['IfcDoor'], op: 'in' });

    const groups = useViewerStore.getState().searchFilter.groups;
    assert.equal(groups.length, 2);
    assert.equal(groups[0].rules.length, 1);
    assert.equal(groups[1].rules.length, 1);
    if (groups[0].rules[0].kind === 'ifcType') assert.deepEqual(groups[0].rules[0].values, ['IfcWall']);
    if (groups[1].rules[0].kind === 'ifcType') assert.deepEqual(groups[1].rules[0].values, ['IfcDoor']);
  });

  it('clicking a group tab switches which group is active', () => {
    const container = mount();
    click(buttonNamed(container, 'Add group')); // now 2 groups, group 2 (index 1) active

    const group1Tab = Array.from(container.querySelectorAll('button[role="tab"]'))
      .find((b) => b.textContent?.includes('Group 1'));
    assert.ok(group1Tab, 'no "Group 1" tab rendered');
    mouseDown(group1Tab);

    assert.equal(useViewerStore.getState().searchFilterActiveGroup, 0);
  });

  it('#5815 ArrowLeft selects the previous group and labels its rule panel', async () => {
    const container = mount();
    click(buttonNamed(container, 'Add group'));
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    assert.equal(tabs.length, 2);
    tabs[1].focus();
    press(tabs[1], 'ArrowLeft');
    await advance(5);
    assert.equal(useViewerStore.getState().searchFilterActiveGroup, 0);
    assert.equal(document.activeElement, tabs[0]);
    const panel = container.querySelector('[role="tabpanel"]');
    assert.ok(panel);
    assert.equal(panel.getAttribute('aria-labelledby'), tabs[0].id);
    const tablist = container.querySelector('[role="tablist"]');
    assert.ok(tablist);
    assert.equal(tablist.querySelectorAll('button').length, 2, 'the tablist contains only tab controls');
    const removeGroup = container.querySelector('button[aria-label="Remove group 2"]');
    assert.ok(removeGroup);
    assert.ok(panel.compareDocumentPosition(removeGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the rule panel follows the active tab before removal controls in keyboard order');
  });

  it('removing a group clamps the active index and never drops the last group', () => {
    const container = mount();
    click(buttonNamed(container, 'Add group'));
    assert.equal(useViewerStore.getState().searchFilter.groups.length, 2);

    const removeGroup2 = container.querySelector('button[aria-label="Remove group 2"]');
    assert.ok(removeGroup2, 'no remove-group-2 button rendered');
    click(removeGroup2);

    const state = useViewerStore.getState();
    assert.equal(state.searchFilter.groups.length, 1);
    assert.equal(state.searchFilterActiveGroup, 0);
    // A single group renders no tabs row (and so no remove button) at all.
    assert.equal(container.querySelector('[role="tablist"]'), null);
  });
});
