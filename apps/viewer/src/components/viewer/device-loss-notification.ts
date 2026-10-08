/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A delayed toast-module import must not publish an earlier state after a
// replacement device has already failed or recovered (#6855).
let notificationVersion = 0;
const KEY = 'viewport-device-health';

export function notifyDeviceHealth(type: 'error' | 'success', message: string): void {
  const version = ++notificationVersion;
  void import('@/components/ui/toast').then(({ toast }) => {
    if (version !== notificationVersion) return;
    if (type === 'error') toast.error(message, KEY);
    else toast.success(message, undefined, KEY);
  }).catch((error) => {
    console.warn('[Viewport] device-health notification unavailable:', error);
  });
}
