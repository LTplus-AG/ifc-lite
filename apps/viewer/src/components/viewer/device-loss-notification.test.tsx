/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render';
import { Toaster, toast } from '@/components/ui/toast';
import { notifyDeviceHealth } from './device-loss-notification';
import { reportDeviceLost, resetDeviceLossReportForTests } from './device-loss-report';
import { reportDeviceRecovery } from './device-loss-recovery-report';

async function settle() {
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
}
function dismissAll(ui: HTMLElement) {
  for (const button of ui.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss notification"]')) act(() => button.click());
}
afterEach(() => { cleanup(); resetDeviceLossReportForTests(); });

// #6855: exercise native reporters and the mounted toast store, not a notification mock.
test('device health replaces earlier loss, failure and recovery while retaining unrelated errors', async () => {
  resetDeviceLossReportForTests();
  const ui = render(<Toaster />);
  dismissAll(ui);
  act(() => toast.error('Unrelated export failure'));
  reportDeviceLost({ reason: 'unknown', message: 'test loss' }, undefined, true);
  await settle();
  assert.match(ui.textContent ?? '', /Automatic recovery is starting/);
  reportDeviceRecovery({ ok: false, reason: 'device-init-failed' }, () => resetDeviceLossReportForTests());
  await settle();
  assert.match(ui.textContent ?? '', /could not recover automatically/);
  assert.doesNotMatch(ui.textContent ?? '', /Automatic recovery is starting/);
  reportDeviceRecovery({ ok: true, omissions: [] }, () => resetDeviceLossReportForTests());
  await settle();
  assert.match(ui.textContent ?? '', /3D view recovered/);
  assert.doesNotMatch(ui.textContent ?? '', /could not recover/);
  reportDeviceLost({ reason: 'unknown', message: 'replacement lost' }, undefined, true);
  await settle();
  assert.doesNotMatch(ui.textContent ?? '', /3D view recovered/);
  assert.match(ui.textContent ?? '', /Automatic recovery is starting/);
  assert.match(ui.textContent ?? '', /Unrelated export failure/);
  assert.equal(ui.querySelectorAll('button[aria-label="Dismiss notification"]').length, 2);
  dismissAll(ui);
});

test('an older asynchronous notification cannot overwrite the latest device state', async () => {
  const ui = render(<Toaster />);
  dismissAll(ui);
  notifyDeviceHealth('success', 'Obsolete recovery');
  notifyDeviceHealth('error', 'Latest replacement loss');
  await settle();
  assert.doesNotMatch(ui.textContent ?? '', /Obsolete recovery/);
  assert.match(ui.textContent ?? '', /Latest replacement loss/);
  assert.equal(ui.querySelectorAll('button[aria-label="Dismiss notification"]').length, 1);
  dismissAll(ui);
});
