/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5871 — the "SHORTCUTS ?" chip on the empty viewer is a real button that
 * opens the Info dialog on its Shortcuts tab. It used to be a `<div>` with no
 * handler, so clicking it did nothing. Asserted through the rendered empty
 * state of `ViewportContainer`, so the test reads the same before and after
 * the chip moved into its own module.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render.js';
import { viewportLightingEn } from '@/i18n/catalogues/viewport-lighting.en';
import { EVENT_SHOW_SHORTCUTS } from '@/lib/tours/events';
import { useViewerStore } from '@/store';
import { ViewportContainer } from './ViewportContainer.js';

const LABEL = viewportLightingEn['viewportLighting.container.emptyState.footer.shortcutsLabel'] as string;

beforeEach(() => {
  // The no-model empty state, where the chips render.
  useViewerStore.setState({ ifcDataStore: null, geometryResult: null, models: new Map() });
});
afterEach(() => cleanup());

describe('empty-state shortcuts chip (#5871)', () => {
  it('is a button that opens the Info dialog on the Shortcuts tab', () => {
    const container = render(<ViewportContainer />);
    const label = [...container.querySelectorAll('span')].find((s) => s.textContent === LABEL);
    assert.ok(label, 'the shortcuts chip renders on the empty state');
    const chip = label.closest('button');
    assert.ok(chip, 'the shortcuts chip must be a <button>, not a clickable-looking <div>');

    const received: Array<{ tab?: string } | undefined> = [];
    const listener = (e: Event) => received.push((e as CustomEvent<{ tab?: string }>).detail);
    window.addEventListener(EVENT_SHOW_SHORTCUTS, listener);
    try {
      click(chip);
    } finally {
      window.removeEventListener(EVENT_SHOW_SHORTCUTS, listener);
    }
    assert.deepEqual(received, [{ tab: 'shortcuts' }]);
  });
});
