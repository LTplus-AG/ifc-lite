/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5851 — the one in-viewport load-error card. It shows the full message
 * (no truncation), a Retry that re-runs `lastLoadRetry` (the load path's own
 * closure over the same File or URL), and Dismiss.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { ViewportLoadErrorCard } from './ViewportLoadErrorCard.js';

beforeEach(() => {
  act(() => useViewerStore.setState({ error: null, lastLoadRetry: null }));
});

afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState({ error: null, lastLoadRetry: null }));
});

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  assert.ok(button, `a "${text}" button is rendered`);
  return button as HTMLButtonElement;
}

describe('ViewportLoadErrorCard (#5851)', () => {
  it('is not rendered when there is no error', () => {
    const container = render(<ViewportLoadErrorCard />);
    assert.equal(container.querySelector('[data-viewport-load-error-card]'), null);
  });

  it('shows the full message as an alert, with no truncation', () => {
    const longMessage = 'Could not download the linked model: '.repeat(5) + 'network error';
    act(() => useViewerStore.setState({ error: longMessage }));
    const container = render(<ViewportLoadErrorCard />);
    const card = container.querySelector('[role="alert"]');
    assert.ok(card, 'the card is an alert live region');
    assert.ok(card?.textContent?.includes(longMessage), 'the full message is shown, not clipped');
  });

  it('Retry calls the load path\'s own retry closure — the same File or URL through loadFile', () => {
    let retried = 0;
    act(() => useViewerStore.setState({ error: 'boom', lastLoadRetry: () => { retried += 1; } }));
    const container = render(<ViewportLoadErrorCard />);
    click(findButton(container, 'Retry'));
    assert.equal(retried, 1);
  });

  it('has no Retry button when the failed attempt cannot be replayed', () => {
    act(() => useViewerStore.setState({ error: 'boom', lastLoadRetry: null }));
    const container = render(<ViewportLoadErrorCard />);
    assert.equal([...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Retry'), false);
  });

  it('Dismiss clears the error without retrying', () => {
    let retried = 0;
    act(() => useViewerStore.setState({ error: 'boom', lastLoadRetry: () => { retried += 1; } }));
    const container = render(<ViewportLoadErrorCard />);
    click(findButton(container, 'Dismiss'));
    assert.equal(useViewerStore.getState().error, null);
    assert.equal(useViewerStore.getState().lastLoadRetry, null, 'dismiss releases the captured load source');
    assert.equal(retried, 0);
  });
});
