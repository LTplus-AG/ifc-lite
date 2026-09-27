/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { click, cleanup, render, type as enterText } from '@/test/render.js';
import { openSettings } from '@/lib/settings/open-settings.js';
import { useViewerStore } from '@/store';
import { SettingsDialogHost } from './SettingsDialog.js';

afterEach(cleanup);
const EXPECTED_MAX_DISPLAY_NAME_LENGTH = 64;

it('Settings → Collaboration saves a trimmed, bounded display name and rejects blank input (#5863)', () => {
  act(() => useViewerStore.getState().setCollabIdentity({ name: 'Before' }));
  render(<SettingsDialogHost />);
  act(() => openSettings('collaboration'));

  const dialog = document.querySelector('[data-settings-dialog]');
  assert.ok(dialog);
  const input = dialog.querySelector<HTMLInputElement>('#settings-collab-name');
  const save = dialog.querySelector<HTMLButtonElement>('button[type="submit"]');
  assert.ok(input && save, 'Collaboration settings expose an editable name and save action');
  assert.equal(input.value, 'Before');

  enterText(input, '  Ada Lovelace  ');
  click(save);
  assert.equal(useViewerStore.getState().collabIdentity.name, 'Ada Lovelace');
  assert.equal(JSON.parse(localStorage.getItem('ifc-lite:collab:identity') ?? '{}').name, 'Ada Lovelace');

  enterText(input, '   ');
  assert.equal(save.disabled, true);
  assert.equal(useViewerStore.getState().collabIdentity.name, 'Ada Lovelace');

  assert.equal(input.maxLength, EXPECTED_MAX_DISPLAY_NAME_LENGTH);
  act(() => useViewerStore.getState().setCollabIdentity({ name: 'x'.repeat(EXPECTED_MAX_DISPLAY_NAME_LENGTH + 12) }));
  assert.equal(useViewerStore.getState().collabIdentity.name, 'x'.repeat(EXPECTED_MAX_DISPLAY_NAME_LENGTH));
  act(() => useViewerStore.getState().setCollabIdentity({ name: `${'x'.repeat(EXPECTED_MAX_DISPLAY_NAME_LENGTH - 1)} y` }));
  assert.equal(useViewerStore.getState().collabIdentity.name, 'x'.repeat(EXPECTED_MAX_DISPLAY_NAME_LENGTH - 1));
});
