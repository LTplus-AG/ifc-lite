/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import GlobePlacementControl from '@/components/viewer/properties/GlobePlacementControl.js';
import { LocationGeoreferenceNotices } from '@/components/viewer/properties/location-georeference-notices.js';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { CONTRAST_BROWSER_SKIP, closeContrastBrowser, withThemedPage, measureTextContrastOnSurface, type Theme } from './render-harness.js';
import { WCAG_AA_NORMAL_TEXT } from './wcag.js';

const initialMode = useViewerStore.getState().cesiumGlobePlacement;
const initialStatus = useViewerStore.getState().cesiumGlobePlacementStatus;
afterEach(() => {
  cleanup();
  useViewerStore.setState({ cesiumGlobePlacement: initialMode, cesiumGlobePlacementStatus: initialStatus });
});
after(closeContrastBrowser);

// #8802 batch 3: exercise real diagnostic conditions, without mocking their
// components or reading source. The DOM assertion also provides a bounded
// revert oracle on hosts whose Chrome cannot complete canvas reads.
const states = [
  {
    name: 'explicit globe placement contradicts the prescribed operation',
    mount: () => {
      useViewerStore.setState({ cesiumGlobePlacement: 'anchor', cesiumGlobePlacementStatus: { mode: 'anchor', anchorErrorMetres: 1, prescribed: 'exact' } });
      return render(<GlobePlacementControl />);
    },
    selector: '[role="note"]',
  },
  {
    name: 'geometry and site disagree with the declared origin',
    mount: () => render(<LocationGeoreferenceNotices locationKind="geometry" geometryDistanceKm={12} siteDistanceMetres={500} />),
    selector: 'output',
  },
];

describe('properties status roles (Refs #8802)', () => {
  for (const state of states) {
    it(`${state.name} renders warning roles`, () => {
      const ui = state.mount();
      const notices = ui.querySelectorAll(state.selector);
      assert.ok(notices.length > 0, 'diagnostic state is visible');
      for (const notice of notices) {
        assert.ok(notice.textContent?.trim(), 'diagnostic explains the warning');
        assert.ok(notice.classList.contains('text-warn'), 'diagnostic uses the warning role');
      }
    });
    for (const theme of ['light', 'dark', 'colorful'] as Theme[]) {
      it(`${state.name} paints the warning role and clears AA in ${theme}`, { skip: CONTRAST_BROWSER_SKIP }, async () => {
        const ui = state.mount();
        const notice = ui.querySelector(state.selector);
        assert.ok(notice);
        await withThemedPage(theme, `<div class="bg-card text-foreground">${ui.innerHTML}</div><span id="expected" class="text-warn"></span>`, async page => {
          const actual = await page.$$eval(state.selector, nodes => nodes.map(el => getComputedStyle(el).color));
          const expected = await page.$eval('#expected', el => getComputedStyle(el).color);
          for (const color of actual) assert.equal(color, expected, 'diagnostic paints the warning role');
        });
        const ratio = await measureTextContrastOnSurface(theme, 'bg-card', notice.className);
        assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `warning contrast ${ratio.toFixed(2)}:1 in ${theme}`);
      });
    }
  }
});
