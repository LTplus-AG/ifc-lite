/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { validationPanelEn } from '@/i18n/catalogues/validation-panel.en';
import { SavedHistoryNotice } from './SavedHistoryNotice';

const keys = ['validationPanel.history.recovered', 'validationPanel.history.blocked', 'validationPanel.history.unavailable', 'validationPanel.history.retrySave'] as const;
const pseudo: Catalogue = Object.fromEntries(keys.map((key) => [key, `Marked ${key}: ${validationPanelEn[key]}`]));
registerLocale('saved-history-notice-6500', pseudo);
afterEach(() => { cleanup(); setLocale('en'); });

describe('shared saved report recovery notice (#6500/#6506)', () => {
  for (const issue of ['recovered', 'blocked', 'unavailable'] as const) {
    it(`distinguishes ${issue} and retranslates the actual notice and retry control`, () => {
      let retries = 0;
      const ui = render(<SavedHistoryNotice issue={issue} subject="Fixture reports" onRetry={() => { retries++; }} />);
      const key = `validationPanel.history.${issue}` as const;
      const english = validationPanelEn[key].replace('{subject}', 'Fixture reports');
      assert.ok(ui.querySelector(`[role="alert"][data-saved-history-issue="${issue}"]`));
      assert.ok(ui.textContent?.includes(english));
      assert.equal(ui.querySelectorAll('button').length, issue === 'recovered' ? 0 : 1);
      act(() => setLocale('saved-history-notice-6500'));
      assert.ok(ui.textContent?.includes(`Marked ${key}: ${english}`));
      if (issue !== 'recovered') {
        const retry = ui.querySelector('button'); assert.ok(retry);
        assert.equal(retry.textContent, 'Marked validationPanel.history.retrySave: Retry save');
        click(retry);
        assert.equal(retries, 1, 'retry explicitly invokes the preserving-save action');
      }
    });
  }
});
