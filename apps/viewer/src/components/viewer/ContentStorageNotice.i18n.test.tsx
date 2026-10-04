/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render, waitFor } from '@/test/render';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { validationPanelEn } from '@/i18n/catalogues/validation-panel.en';
import type { ContentStatus } from '@/lib/storage/content-library';
import { ContentStorageNotice } from './ContentStorageNotice';

const pseudo: Catalogue = Object.fromEntries(Object.entries(validationPanelEn)
  .filter(([key]) => key.startsWith('contentStorage.') || key === 'validationPanel.history.retrySave')
  .map(([key, value]) => [key, `Marked ${value}`]));
registerLocale('content-storage-notice-6679', pseudo);
afterEach(() => { cleanup(); setLocale('en'); });

describe('user content recovery notice localization (#6679)', () => {
  for (const failure of ['quota', 'unavailable', 'conflict', 'invalid'] as const) {
    it(`retranslates ${failure} and its explicit retry control without losing the draft status`, async () => {
      let retries = 0;
      const status: ContentStatus = { phase: 'ready', recovered: true, items: { draft: failure } };
      const ui = render(<ContentStorageNotice status={status} retry={async () => { retries++; return true; }} restore={async () => true} />);
      const message = validationPanelEn[`contentStorage.${failure}`];
      assert.ok(ui.textContent?.includes(message));
      assert.ok(ui.textContent?.includes(validationPanelEn['contentStorage.recovered']));
      act(() => setLocale('content-storage-notice-6679'));
      assert.ok(ui.textContent?.includes(`Marked ${message}`));
      assert.ok(ui.textContent?.includes(`Marked ${validationPanelEn['contentStorage.recovered']}`));
      const retry = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Marked Retry save');
      assert.ok(retry);
      click(retry);
      await waitFor(() => retries === 1, 'localized retry must invoke the recovery action');
      assert.equal(status.items.draft, failure, 'changing locale leaves the caller-owned draft status intact');
    });
  }
});
