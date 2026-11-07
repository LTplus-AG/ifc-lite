/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Rule } from '@ifc-lite/rules';
import { IDSAuditSummary } from '@/components/viewer/IDSAuditSummary.js';
import { FoldedGroupEditor } from '@/components/viewer/validation/FoldedGroupEditor.js';
import { FLOW_PRIMARY_BUTTON } from '@/components/viewer/flow/flow-button.js';
import { cleanup, render, click } from '@/test/render.js';
import { closeContrastBrowser, withThemedPage, measureTextContrastOnSurface, type Theme } from './render-harness.js';
import { WCAG_AA_NORMAL_TEXT } from './wcag.js';

afterEach(cleanup);
after(closeContrastBrowser);
// #8802 batch 6: real expanded audit rows exercise the newly mapped rails
// and informational chip surface. The range editor exercises the swallowed chip.
describe('remaining root status roles (Refs #8802)', () => {
  for (const [severity, role] of [['error', 'danger'], ['warning', 'warn'], ['info', 'info']] as const) {
    for (const theme of ['light', 'dark', 'colorful'] as Theme[]) {
      it(`${severity} audit row paints its role and clears AA in ${theme}`, async () => {
        const ui = render(<IDSAuditSummary report={{ status: 'error', issues: [{ severity, code: 'E_PARSE_XML', message: 'Audit diagnostic', path: '/' }] }} />);
        const expand = ui.querySelector('button');
        assert.ok(expand);
        click(expand);
        const chip = ui.querySelector('code');
        assert.ok(chip);
        await withThemedPage(theme, `<div class="bg-card">${ui.innerHTML}</div><div id="expected" class="border-l-${role}-border bg-${role}-surface text-${role}"></div>`, async page => {
          const colors = await page.$eval('#expected', el => {
            const s = getComputedStyle(el);
            return { rail: s.borderLeftColor, bg: s.backgroundColor, ink: s.color };
          });
          assert.equal(await page.$eval('li', el => getComputedStyle(el).borderLeftColor), colors.rail);
          assert.equal(await page.$eval('code', el => getComputedStyle(el).backgroundColor), colors.bg);
          assert.equal(await page.$eval('code', el => getComputedStyle(el).color), colors.ink);
        });
        // The chip's own status surface over the card, which is what users read.
        const ratio = await measureTextContrastOnSurface(theme, `bg-${role}-surface`, `text-${role}`, 'bg-card');
        assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `contrast ${ratio.toFixed(2)}:1 in ${theme}`);
      });
    }
  }
  for (const theme of ['light', 'dark', 'colorful'] as Theme[]) {
    it(`Flow's primary action uses the primary role in ${theme}`, async () => {
      await withThemedPage(theme, `<div class="bg-card"><button id="action" class="${FLOW_PRIMARY_BUTTON}">Run</button><i id="expected" class="border border-primary text-primary"></i></div>`, async page => {
        const read = (selector: string) => page.$eval(selector, el => {
          const s = getComputedStyle(el);
          return { ink: s.color, edge: s.borderTopColor };
        });
        assert.deepEqual(await read('#action'), await read('#expected'));
      });
      // The colorful theme's primary is low contrast everywhere (3.33:1 here). The
      // maintainer accepted it as a deliberate exception on #8802 (2026-11-07), so
      // in colorful this checks only that Flow follows the role.
      if (theme === 'colorful') return;
      const ratio = await measureTextContrastOnSurface(theme, 'bg-card', FLOW_PRIMARY_BUTTON);
      assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `contrast ${ratio.toFixed(2)}:1 in ${theme}`);
    });
  }
  // `.dark .bg-white` wins over any `dark:bg-*` beside it, which is why those
  // classes could be dropped: dark mode paints the panel surface either way.
  it('a white surface paints the panel in dark mode, so a dark:bg class beside it does nothing', async () => {
    await withThemedPage('dark', '<div id="white" class="bg-white"></div><div id="both" class="bg-white dark:bg-muted"></div><div id="panel" class="bg-card"></div>', async page => {
      const bg = (selector: string) => page.$eval(selector, el => getComputedStyle(el).backgroundColor);
      assert.equal(await bg('#both'), await bg('#white'));
      assert.equal(await bg('#white'), await bg('#panel'));
    });
  });
  it('dark range chip and remove hover differ from their surface', async () => {
    const ui = render(<FoldedGroupEditor groups={[{ combinator: 'AND', rules: [Rule.attribute('Tag', 'gte', '10'), Rule.attribute('Tag', 'lte', '20')] }]} activeGroup={0} models={[]} onChange={() => {}} />);
    const chip = ui.querySelector('input[type="number"]')?.parentElement?.querySelector('span');
    assert.ok(chip?.parentElement);
    await withThemedPage('dark', `<div id="range">${chip.parentElement.outerHTML}</div>`, async page => {
      const surface = await page.$eval('#range > div', el => getComputedStyle(el).backgroundColor);
      const chipColor = await page.$eval('#range > div > span', el => getComputedStyle(el).backgroundColor);
      assert.notEqual(chipColor, surface, 'between chip stays visible');
      const button = () => page.$eval('#range button', el => getComputedStyle(el).backgroundColor);
      const resting = await button();
      await page.hover('#range button');
      const hover = await button();
      assert.notEqual(hover, resting, 'remove hover changes the button');
      assert.notEqual(hover, surface, 'remove hover stays visible on its surface');
    });
  });
});
