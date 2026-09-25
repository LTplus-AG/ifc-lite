/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The classic strip's Presentation button reads whether the `presentation`
 * panel is OPEN, the same set the ribbon's Present button reads (#5508), not
 * the raw dock flag. A floating or popped-out panel has its dock flag cleared
 * by the sidebar's single-tenant rule while it is still on screen, so a latch
 * keyed on the flag goes dark over an open panel. #5987 moved the ribbon off
 * the flag and left the classic strip on it; toolbar-parity.test.ts caught
 * the drift only as a classic-only `basketPresentationVisible` read, and
 * #6002 fixed it. This pins the behaviour, not the symbol.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { MainToolbar } from '../MainToolbar.js';

function presentationButton(): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>('button[aria-label]')].find((b) =>
    (b.getAttribute('aria-label') ?? '').endsWith('Presentation dock'),
  );
  assert.ok(found, 'the classic strip has no Presentation button');
  return found;
}

describe('classic Presentation button follows the open panel, not the dock flag (#5508)', () => {
  beforeEach(() => {
    useViewerStore.setState({ floatingPanels: [], poppedOutIds: [], basketPresentationVisible: false });
  });
  afterEach(cleanup);

  it('is pressed while the panel floats with its dock flag cleared', () => {
    act(() => useViewerStore.getState().floatPanel('presentation'));
    useViewerStore.setState({ basketPresentationVisible: false });
    render(<MainToolbar />);
    const button = presentationButton();
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(button.getAttribute('aria-label'), 'Hide Presentation dock');
  });

  it('is pressed while docked and released when nothing is open', () => {
    useViewerStore.setState({ basketPresentationVisible: true });
    render(<MainToolbar />);
    assert.equal(presentationButton().getAttribute('aria-pressed'), 'true');
    act(() => useViewerStore.setState({ basketPresentationVisible: false }));
    assert.equal(presentationButton().getAttribute('aria-pressed'), 'false');
  });
});
