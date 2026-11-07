/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Rule } from '@ifc-lite/rules';
import { IDSAuditSummary } from '@/components/viewer/IDSAuditSummary.js';
import { FoldedGroupEditor } from '@/components/viewer/validation/FoldedGroupEditor.js';
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
        const ratio = await measureTextContrastOnSurface(theme, `bg-card`, `${chip.className}`);
        assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `contrast ${ratio.toFixed(2)}:1 in ${theme}`);
      });
    }
  }
  it('dark range chip and remove hover differ from their restored surface', async () => {
    const ui = render(<FoldedGroupEditor groups={[{ combinator: 'AND', rules: [Rule.attribute('Tag', 'gte', '10'), Rule.attribute('Tag', 'lte', '20')] }]} activeGroup={0} models={[]} onChange={() => {}} />);
    const chip = ui.querySelector('input[type="number"]')?.parentElement?.querySelector('span');
    assert.ok(chip?.parentElement);
    await withThemedPage('dark', `<div id="range">${chip.parentElement.outerHTML}</div>`, async page => {
      const surface = await page.$eval('#range > div', el => getComputedStyle(el).backgroundColor);
      const chipColor = await page.$eval('#range > div > span', el => getComputedStyle(el).backgroundColor);
      assert.notEqual(chipColor, surface, 'between chip stays visible');
      await page.hover('#range button');
      const hover = await page.$eval('#range button', el => getComputedStyle(el).backgroundColor);
      assert.notEqual(hover, surface, 'remove hover stays visible');
    });
  });
});
