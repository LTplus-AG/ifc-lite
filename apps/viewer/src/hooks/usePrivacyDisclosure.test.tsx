/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { Toaster } from '@/components/ui/toast.js';
import { SettingsDialogHost } from '@/components/viewer/settings/SettingsDialog.js';
import { registerLocale, setLocale } from '@/i18n';
import { advance, cleanup, click, render } from '@/test/render.js';
import { latestToast } from '@/test/toasts.js';
import { usePrivacyDisclosure } from './usePrivacyDisclosure.js';

function Disclosure() {
  usePrivacyDisclosure();
  return null;
}

afterEach(() => {
  cleanup();
  setLocale('en');
  localStorage.removeItem('ifclite.extensions.privacy-disclosure.v2');
});

it('translates the analytics disclosure and opens Settings → Privacy (#5866)', async () => {
  localStorage.removeItem('ifclite.extensions.privacy-disclosure.v2');
  registerLocale('privacy-disclosure-test', {
    'settings.privacy.toastDisclosure': 'TRANSLATED ANALYTICS DISCLOSURE',
    'settings.privacy.toastAction': 'OPEN TRANSLATED PRIVACY',
  });
  act(() => setLocale('privacy-disclosure-test'));
  const host = new ExtensionHostService({
    sdk: createBimContext({
      transport: {
        send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
        subscribe: () => () => {},
        close: () => {},
      },
    }),
  });
  render(
    <ExtensionHostContext.Provider value={host}>
      <SettingsDialogHost />
      <Toaster />
      <Disclosure />
    </ExtensionHostContext.Provider>,
  );

  await advance(3550);
  assert.match(latestToast(), /TRANSLATED ANALYTICS DISCLOSURE/);
  const action = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('OPEN TRANSLATED PRIVACY'));
  assert.ok(action, 'the disclosure has a Settings → Privacy action');
  click(action);
  assert.ok(document.querySelector('[data-settings-dialog] #settings-analytics-opt-out'));
  assert.ok(localStorage.getItem('ifclite.extensions.privacy-disclosure.v2'));
});
