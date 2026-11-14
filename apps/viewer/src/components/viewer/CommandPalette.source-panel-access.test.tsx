/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { click, type, waitFor } from '@/test/render';
import { launchDestination, namedButton } from '@/test/palette-destinations';
import { loadSavedSourcePrefs } from '@/lib/sources/preferences';
import { resetReviewAccess, disposeReviewAccess, mountReviewAccess, required,
  dialog, cancelDialog } from '@/test/palette-review-panel-witness';

beforeEach(resetReviewAccess);
afterEach(disposeReviewAccess);
function daluxRow() {
  const row = [...document.querySelectorAll('li')].find(node => node.textContent?.includes('Dalux Box'));
  assert.ok(row, 'actual built-in Dalux provider in lazy SourcesPanel'); return row;
}

test('#8947 palette Sources mounts lazy provider body and Configure cancels/reopens without saving or connecting', async () => {
  mountReviewAccess(); await launchDestination('panel:sources', 'cloud sources');
  await waitFor(() => [...document.querySelectorAll('li')].some(node => node.textContent?.includes('Dalux Box')), 'actual lazy SourcesPanel body');
  const row = daluxRow();
  assert.equal(namedButton('Browse Dalux Box', row).disabled, true, 'missing API key blocks browsing');
  assert.equal(row.querySelector('output')?.textContent?.trim(), 'Add the required settings to browse');
  assert.deepEqual(loadSavedSourcePrefs('dalux-build'), {});
  // SourcesPanel owns SourceSettingsDialog; use the row's actual action name.
  click(namedButton('Configure source', row));
  assert.ok(dialog().textContent?.includes('Dalux Box'));
  const key = required<HTMLInputElement>('#pref-apiKey', dialog());
  assert.equal(key.type, 'password');
  assert.equal(namedButton('Save', dialog()).disabled, true);
  assert.equal(namedButton('Test connection', dialog()).disabled, true);
  type(key, 'unsaved-local-draft');
  assert.equal(namedButton('Save', dialog()).disabled, false);
  assert.equal(namedButton('Test connection', dialog()).disabled, false);
  await cancelDialog();
  assert.deepEqual(loadSavedSourcePrefs('dalux-build'), {}, 'cancel never saves the credential');
  assert.equal(namedButton('Browse Dalux Box', daluxRow()).disabled, true, 'cancel did not configure provider');
  click(namedButton('Configure source', daluxRow()));
  assert.equal(required<HTMLInputElement>('#pref-apiKey', dialog()).value, '', 'cancel discarded credential draft');
  assert.equal(namedButton('Save', dialog()).disabled, true);
  await cancelDialog();
  assert.deepEqual(loadSavedSourcePrefs('dalux-build'), {});
});
