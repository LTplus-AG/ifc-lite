/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRAST_BROWSER_SKIP,
  closeContrastBrowser,
  measureTextContrastOnSurface,
  warmContrastBrowser,
  withThemedPage,
  type Theme,
} from './render-harness';
import { WCAG_AA_NORMAL_TEXT } from './wcag';

const THEMES: Theme[] = ['light', 'dark', 'colorful'];
const ROLES = [
  ['warn', 'text-warn', 'bg-warn-surface'],
  ['ok', 'text-ok', 'bg-ok-surface'],
  ['danger', 'text-danger', 'bg-danger-surface'],
  ['info', 'text-info', 'bg-info-surface'],
] as const;

before(warmContrastBrowser);
after(closeContrastBrowser);

// #8802: the role utilities must exist and paint their own colours. Without
// this, an undefined `text-warn` would inherit the foreground and pass the
// contrast checks below vacuously.
describe('status role utilities resolve to their own colours (#8802)', () => {
  for (const theme of THEMES) {
    for (const [role, text, surface] of ROLES) {
      it(`${role} text and surface are painted in ${theme}`, { skip: CONTRAST_BROWSER_SKIP }, async () => {
        const { roleColor, plainColor, surfaceColor } = await withThemedPage(
          theme,
          `<span id="plain">Plain</span><span id="role" class="${text}">Role</span><div id="surface" class="${surface}">Surface</div>`,
          async (page) => ({
            roleColor: await page.$eval('#role', (el) => getComputedStyle(el).color),
            plainColor: await page.$eval('#plain', (el) => getComputedStyle(el).color),
            surfaceColor: await page.$eval('#surface', (el) => getComputedStyle(el).backgroundColor),
          }),
        );
        assert.notEqual(roleColor, plainColor, `${text} in ${theme} paints the inherited text colour`);
        assert.notEqual(surfaceColor, 'rgba(0, 0, 0, 0)', `${surface} in ${theme} is transparent`);
      });
    }
  }
});

// #8802: measure real compiled utilities in Chrome, including the translucent
// status fill painted over the card. Token changes must preserve both pairs.
describe('status roles meet WCAG AA on card and their own surface (#8802)', () => {
  for (const theme of THEMES) {
    for (const [role, text, surface] of ROLES) {
      for (const background of ['bg-card', surface]) {
        it(`${role} on ${background} clears AA in ${theme}`, { skip: CONTRAST_BROWSER_SKIP }, async () => {
          const ratio = await measureTextContrastOnSurface(theme, background, text, 'bg-card');
          assert.ok(
            ratio >= WCAG_AA_NORMAL_TEXT,
            `${role} on ${background} in ${theme}: ${ratio.toFixed(2)}:1; expected >= ${WCAG_AA_NORMAL_TEXT}:1`,
          );
        });
      }
    }
  }
});
