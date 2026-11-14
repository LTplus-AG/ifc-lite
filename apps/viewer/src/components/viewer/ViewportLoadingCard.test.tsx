/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5849 — while a model loads, the viewport shows a loading card with the
 * active phase and percentage (the same progress the toolbars show) and a
 * Cancel button wired to the load's published canceller.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ComponentType } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';

// Dynamic: the revert oracle deletes the card, and a static import would fail
// the whole file instead of letting the assertions go red.
let ViewportLoadingCard: ComponentType | undefined;
try {
  ({ ViewportLoadingCard } = await import('./ViewportLoadingCard.js'));
} catch (error) {
  console.error('[ViewportLoadingCard.test] card unavailable; assertions will fail', error instanceof Error ? error.message : error);
}

beforeEach(() => {
  act(() => useViewerStore.setState({
    loading: true,
    progress: { phase: 'Loading file', percent: 5 },
    metadataProgress: null,
    geometryProgress: { phase: 'Processing geometry', percent: 42 },
    activeStreamCanceller: null,
    activeLoadCanceller: null,
  }));
});

afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState({ loading: false, progress: null, geometryProgress: null, activeStreamCanceller: null, activeLoadCanceller: null, loadingFileName: null }));
});

function renderCard(): HTMLElement {
  assert.ok(ViewportLoadingCard, 'ViewportLoadingCard must exist');
  const Card = ViewportLoadingCard;
  return render(<Card />);
}

describe('in-viewport loading card (#5849)', () => {
  it('shows the active phase and percentage while a model loads', () => {
    const container = renderCard();
    const status = container.querySelector('output');
    assert.ok(status, 'the card announces progress through an <output> live region');
    const text = status.textContent ?? '';
    assert.ok(text.includes('Processing geometry'), `geometry progress wins over the generic phase: ${text}`);
    assert.ok(text.includes('42%'), `shows the percentage: ${text}`);
  });

  it('Cancel calls the model load\'s canceller', () => {
    let cancelled = 0;
    act(() => useViewerStore.setState({ activeLoadCanceller: () => { cancelled += 1; } }));
    const container = renderCard();
    const button = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Cancel');
    assert.ok(button, 'a Cancel button is rendered when the load can be cancelled');
    click(button);
    assert.equal(cancelled, 1);
  });

  it('names the file being loaded, including a federated add with no model record yet', () => {
    act(() => useViewerStore.setState({ loadingFileName: 'added.ifc', models: new Map() }));
    const container = renderCard();
    const card = container.querySelector('[data-viewport-loading-card]');
    assert.ok(card?.textContent?.includes('added.ifc'), `the card names the file: ${card?.textContent}`);
    const status = container.querySelector('output');
    assert.ok(status?.textContent?.includes('added.ifc'), `the live region announces which file: ${status?.textContent}`);
  });

  it('uses compact visible phases while preserving detailed accessible progress', () => {
    const container = renderCard();
    const visiblePhase = () => container.querySelector('output [aria-hidden="true"]')?.textContent;
    assert.equal(visiblePhase(), 'Geometry');
    for (const [phase, expected] of [
      ['Parsing IFCX (client-side)', 'Parsing'], ['Hydrating properties', 'Metadata'],
      ['Rendering geometry (24 meshes)', 'Rendering'], ['Loading file', 'Reading'],
    ]) {
      act(() => useViewerStore.setState({ geometryProgress: { phase, percent: 64 } }));
      assert.equal(visiblePhase(), expected);
      assert.ok(container.querySelector('output .sr-only')?.textContent?.includes(phase));
    }
  });

  it('handles unknown progress without announcing a fabricated percentage', () => {
    act(() => useViewerStore.setState({ progress: null, geometryProgress: null }));
    const container = renderCard();
    assert.ok(!container.querySelector('output')?.textContent?.includes('%'));
    assert.equal(container.querySelector('button'), null);
  });

  it('is not rendered when nothing is loading', () => {
    act(() => useViewerStore.setState({ loading: false }));
    const container = renderCard();
    assert.equal(container.querySelector('[data-viewport-loading-card]'), null);
  });
});
