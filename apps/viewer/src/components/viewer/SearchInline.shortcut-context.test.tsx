/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `/` summons the toolbar search only when no input-like surface takes the key
 * (#5596). SearchInline shares the global `isTextEntryTarget` guard, so a `/`
 * typed into an ARIA listbox/combobox (type-ahead) must not steal focus.
 */

import '@/test/setup-dom.js';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, press } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { SearchInline } from './SearchInline.js';

let initialState: ReturnType<typeof useViewerStore.getState>;

describe('SearchInline — `/` respects the focused widget (#5596)', () => {
  before(() => { initialState = useViewerStore.getState(); });
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    useViewerStore.setState(initialState, true);
  });
  after(() => { useViewerStore.setState(initialState, true); });

  it('`/` on the page opens search (control)', () => {
    useViewerStore.setState({ searchOpen: false });
    render(<SearchInline />);
    press(document.body, '/');
    assert.equal(useViewerStore.getState().searchOpen, true);
  });

  it('`/` typed inside a role=listbox does not open search', () => {
    useViewerStore.setState({ searchOpen: false });
    render(<SearchInline />);
    const listbox = document.createElement('div');
    listbox.setAttribute('role', 'listbox');
    const option = document.createElement('div');
    option.setAttribute('role', 'option');
    listbox.appendChild(option);
    document.body.appendChild(listbox);
    press(option, '/');
    assert.equal(useViewerStore.getState().searchOpen, false);
  });
});
