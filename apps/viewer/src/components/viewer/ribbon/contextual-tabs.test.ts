/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The contextual-tab policy is the part of the ribbon that moves without
 * being asked, so every rule (and every rule's refusal to fire) is pinned
 * here rather than left to a live browser.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideRibbonTab, NO_TAB_MEMORY, type RibbonContext } from './contextual-tabs.js';

const EMPTY: RibbonContext = { hasModel: false, hasSelection: false, editEnabled: false };
const LOADED: RibbonContext = { hasModel: true, hasSelection: false, editEnabled: false };
const SELECTED: RibbonContext = { hasModel: true, hasSelection: true, editEnabled: false };
const EDITING: RibbonContext = { hasModel: true, hasSelection: false, editEnabled: true };

describe('decideRibbonTab — landing tab', () => {
  it('opens File on a first pass with no model', () => {
    const d = decideRibbonTab(null, EMPTY, 'home', NO_TAB_MEMORY);
    assert.deepEqual(d, { tab: 'file', memory: { autoOpened: 'file', returnTo: 'home' } });
  });

  it('leaves a first pass alone when a model is already loaded', () => {
    assert.equal(decideRibbonTab(null, LOADED, 'home', NO_TAB_MEMORY), null);
  });

  // Switching over from the classic toolbar mid-session is a first pass with
  // live context (PR #1880 review).
  it('opens Author on a first pass while edit mode is already on', () => {
    const d = decideRibbonTab(null, EDITING, 'home', NO_TAB_MEMORY);
    assert.deepEqual(d, { tab: 'author', memory: { autoOpened: 'author', returnTo: 'home' } });
  });

  it('opens Elements on a first pass with something already selected', () => {
    const d = decideRibbonTab(null, SELECTED, 'home', NO_TAB_MEMORY);
    assert.deepEqual(d, { tab: 'elements', memory: { autoOpened: 'elements', returnTo: 'home' } });
  });

  it('lets edit mode outrank selection on a first pass', () => {
    const both: RibbonContext = { hasModel: true, hasSelection: true, editEnabled: true };
    const d = decideRibbonTab(null, both, 'home', NO_TAB_MEMORY);
    assert.deepEqual(d, { tab: 'author', memory: { autoOpened: 'author', returnTo: 'home' } });
  });

  it('leaves a first pass alone when the user is not on the default tab', () => {
    // Switching over from the classic toolbar mid-session must not yank the
    // tab out from under a deliberate choice.
    assert.equal(decideRibbonTab(null, EMPTY, 'analyze', NO_TAB_MEMORY), null);
  });
});

describe('decideRibbonTab — model set', () => {
  it('moves File to Home once the first model lands', () => {
    const d = decideRibbonTab(EMPTY, LOADED, 'file', { autoOpened: 'file', returnTo: 'home' });
    assert.deepEqual(d, { tab: 'home', memory: NO_TAB_MEMORY });
  });

  it('leaves any other tab alone when a model lands', () => {
    assert.equal(decideRibbonTab(EMPTY, LOADED, 'analyze', NO_TAB_MEMORY), null);
  });

  it('falls back to File when the scene empties out', () => {
    const d = decideRibbonTab(LOADED, EMPTY, 'elements', NO_TAB_MEMORY);
    assert.deepEqual(d, { tab: 'file', memory: NO_TAB_MEMORY });
  });
});

describe('decideRibbonTab — selection', () => {
  it('opens Elements on the rising edge from a neutral tab', () => {
    const d = decideRibbonTab(LOADED, SELECTED, 'home', NO_TAB_MEMORY);
    assert.deepEqual(d, { tab: 'elements', memory: { autoOpened: 'elements', returnTo: 'home' } });
  });

  it('does not steal a deliberate tab', () => {
    for (const tab of ['view', 'analyze', 'author'] as const) {
      assert.equal(decideRibbonTab(LOADED, SELECTED, tab, NO_TAB_MEMORY), null, tab);
    }
  });

  it('does not re-fire while the selection merely changes', () => {
    // Element A to element B: still "something selected", no edge.
    assert.equal(decideRibbonTab(SELECTED, SELECTED, 'elements', NO_TAB_MEMORY), null);
  });

  it('hands the tab back when the selection clears', () => {
    const d = decideRibbonTab(SELECTED, LOADED, 'elements', { autoOpened: 'elements', returnTo: 'view' });
    assert.deepEqual(d, { tab: 'view', memory: NO_TAB_MEMORY });
  });

  it('keeps Elements when the user opened it themselves', () => {
    // No memory means the tab is the user's own: clearing a selection must
    // not move them.
    assert.equal(decideRibbonTab(SELECTED, LOADED, 'elements', NO_TAB_MEMORY), null);
  });

  it('does not return when the user has since moved to another tab', () => {
    const d = decideRibbonTab(SELECTED, LOADED, 'analyze', { autoOpened: 'elements', returnTo: 'home' });
    assert.equal(d, null);
  });
});

describe('decideRibbonTab — edit mode', () => {
  it('opens Author when edit mode comes on', () => {
    const d = decideRibbonTab(LOADED, EDITING, 'home', NO_TAB_MEMORY);
    assert.deepEqual(d, { tab: 'author', memory: { autoOpened: 'author', returnTo: 'home' } });
  });

  it('hands the tab back when edit mode goes off', () => {
    const d = decideRibbonTab(EDITING, LOADED, 'author', { autoOpened: 'author', returnTo: 'home' });
    assert.deepEqual(d, { tab: 'home', memory: NO_TAB_MEMORY });
  });

  it('outranks selection: no Elements switch while authoring', () => {
    const editingWithSelection: RibbonContext = { hasModel: true, hasSelection: true, editEnabled: true };
    assert.equal(decideRibbonTab(EDITING, editingWithSelection, 'author', NO_TAB_MEMORY), null);
    // Even from a neutral tab, an authoring session keeps its context.
    assert.equal(decideRibbonTab(EDITING, editingWithSelection, 'home', NO_TAB_MEMORY), null);
  });
});
