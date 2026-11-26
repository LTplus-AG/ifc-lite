/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { registerEnglish } from '@/i18n';
import { registryEn } from '@/i18n/catalogues/registry.en';
import { useHandoffWorkspace } from '@/lib/registry/handoff-workspace';
import { cleanup, render, waitFor } from '@/test/render';
import { RegistryLaunchLoader } from './RegistryLaunchLoader';

registerEnglish(registryEn);
afterEach(() => {
  cleanup();
  useHandoffWorkspace.setState(useHandoffWorkspace.getInitialState(), true);
});

test('a failed handoff load offers a way back to the viewer, not only Retry (#9638 review)', async () => {
  // No authorized handoff in this tab: the load fails before any network request.
  const ui = render(<RegistryLaunchLoader />);
  await waitFor(() => Boolean(ui.querySelector('[role=alert]')), 'the failed load should show its error');
  assert.match(ui.querySelector('[role=alert]')!.textContent ?? '', /Open the selected version again/);
  const exit = [...ui.querySelectorAll('a')].find(anchor => anchor.textContent === 'Go to viewer');
  assert(exit, 'the overlay must offer an exit');
  assert.equal(exit.getAttribute('href'), '/');
});
