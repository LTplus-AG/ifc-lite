/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5851 — the ribbon used to render a load error as a truncated,
 * non-dismissible `<span className="ml-3 max-w-72 truncate …">{error}</span>`
 * next to the tab strip. The one in-viewport load-error card
 * (`ViewportLoadErrorCard`) replaces it; the ribbon renders no error UI of
 * its own any more.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { RibbonToolbar } from './RibbonToolbar.js';

beforeEach(() => {
  setLocale('en');
  act(() => useViewerStore.setState({ ribbonTab: 'home', ribbonCollapsed: false }));
});

afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState({ error: null }));
});

describe('RibbonToolbar load error (#5851)', () => {
  it('renders no error text of its own when the store has a load error', () => {
    const longMessage = 'A'.repeat(200) + ' — the message the truncated span used to clip';
    act(() => useViewerStore.setState({ error: longMessage }));
    const container = render(<RibbonToolbar />);
    assert.equal(
      container.textContent?.includes(longMessage),
      false,
      'the ribbon must not render the load error itself — the viewport card is the one place it shows',
    );
    assert.equal(container.querySelector('.truncate.text-destructive'), null);
  });
});
