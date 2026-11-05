/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SpanQuote } from '@/components/viewer/assistant/SemanticReviewParts.js';
import { FlowTrackingImpacts } from '@/components/viewer/assistant/FlowTrackingImpacts.js';
import { cleanup, render } from '@/test/render.js';
import { closeContrastBrowser, warmContrastBrowser, withThemedPage, measureTextContrastOnSurface, type Theme } from './render-harness.js';
import { WCAG_AA_NORMAL_TEXT } from './wcag.js';

before(warmContrastBrowser);
afterEach(cleanup);
after(closeContrastBrowser);

// #8802 batch 2: mount production states, then paint their actual DOM/classes
// with the shipped stylesheet. Comparing resolved colours also rejects the old
// raw palette even where it happened to clear AA in one theme.
describe('assistant status roles (Refs #8802)', () => {
  for (const theme of ['light', 'dark', 'colorful'] as Theme[]) {
    it(`verified source uses the success role and clears AA in ${theme}`, async () => {
      const ui = render(<SpanQuote span={{ source: 'requirements', start: 0, end: 4, quote: 'Wall' }} check={{ status: 'verified' }} />);
      const badge = ui.querySelector('span');
      assert.ok(badge, 'verified status is rendered');
      await withThemedPage(theme, `<div class="bg-card text-foreground">${ui.innerHTML}</div><span id="expected" class="bg-ok-surface text-ok"></span>`, async page => {
        const actual = await page.$eval('p > span', el => ({ color: getComputedStyle(el).color, fill: getComputedStyle(el).backgroundColor }));
        const expected = await page.$eval('#expected', el => ({ color: getComputedStyle(el).color, fill: getComputedStyle(el).backgroundColor }));
        assert.deepEqual(actual, expected, 'verified source paints the success role');
      });
      const ratio = await measureTextContrastOnSurface(theme, badge.className, badge.className, 'bg-card');
      assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `verified source contrast ${ratio.toFixed(2)}:1 in ${theme}`);
    });

    it(`tracking warning uses warning surface/border and clears AA in ${theme}`, async () => {
      const ui = render(<FlowTrackingImpacts impacts={[{ nodeId: 'wall', effect: 'removed', trackingKey: 'walls', ownedElements: 2 }]} />);
      const alert = ui.querySelector('[role="alert"]');
      assert.ok(alert, 'destructive tracking impact warning is rendered');
      await withThemedPage(theme, `<div class="bg-card text-foreground">${ui.innerHTML}</div><div id="expected" class="bg-warn-surface border border-warn-border"></div>`, async page => {
        const actual = await page.$eval('[role="alert"]', el => ({ fill: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopColor }));
        const expected = await page.$eval('#expected', el => ({ fill: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopColor }));
        assert.deepEqual(actual, expected, 'tracking warning paints the warning roles');
      });
      const ratio = await measureTextContrastOnSurface(theme, alert.className, 'text-foreground', 'bg-card');
      assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `tracking warning contrast ${ratio.toFixed(2)}:1 in ${theme}`);
    });
  }
});
