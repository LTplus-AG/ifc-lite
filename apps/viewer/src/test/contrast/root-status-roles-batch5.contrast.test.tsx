/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IDSAuditSummary } from '@/components/viewer/IDSAuditSummary.js';
import { SelectorFeedbackList } from '@/components/viewer/SearchModal.filter.feedback.js';
import { cleanup, render } from '@/test/render.js';
import { CONTRAST_BROWSER_SKIP, closeContrastBrowser, withThemedPage, measureTextContrastOnSurface, type Theme } from './render-harness.js';
import { WCAG_AA_NORMAL_TEXT } from './wcag.js';

afterEach(cleanup);
after(closeContrastBrowser);
// #8802 batch 5: actual failed audit and selector warning, without mocks.
const states = [
  {
    name: 'IDS audit error count', role: 'danger', selector: '.tabular-nums',
    mount: () => render(<IDSAuditSummary report={{ status: 'error', issues: [{ severity: 'error', code: 'E_PARSE_XML', message: 'Malformed document', path: '/' }] }} />),
  },
  {
    name: 'selector parser warning', role: 'warn', selector: '[role="alert"]',
    mount: () => render(<SelectorFeedbackList feedback={{ tone: 'warning', lines: ['Unsupported selector clause'] }} />),
  },
];
describe('root viewer status roles (Refs #8802)', () => {
  for (const state of states) {
    it(`${state.name} renders its status role`, () => {
      const notice = state.mount().querySelector(state.selector);
      assert.ok(notice, 'status is rendered');
      assert.ok(notice.textContent?.trim(), 'status is visible');
      assert.ok(notice.classList.contains(`text-${state.role}`), 'status uses its colour role');
    });
    for (const theme of ['light', 'dark', 'colorful'] as Theme[]) {
      it(`${state.name} paints its role and clears AA in ${theme}`, { skip: CONTRAST_BROWSER_SKIP }, async () => {
        const ui = state.mount();
        const notice = ui.querySelector(state.selector);
        assert.ok(notice);
        await withThemedPage(theme, `<div class="bg-card text-foreground">${ui.innerHTML}</div><span id="expected" class="text-${state.role}"></span>`, async page => {
          const actual = await page.$eval(state.selector, el => getComputedStyle(el).color);
          const expected = await page.$eval('#expected', el => getComputedStyle(el).color);
          assert.equal(actual, expected, 'status paints its colour role');
        });
        const ratio = await measureTextContrastOnSurface(theme, 'bg-card', notice.className);
        assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `contrast ${ratio.toFixed(2)}:1 in ${theme}`);
      });
    }
  }
});
