/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

let callback: string | null = null;

/** Capture before analytics modules run. Codes live only in memory, never in URL history or storage. */
export function registryLaunchLocation(): string {
  if (callback) return callback;
  const href = window.location.href;
  if (window.location.pathname === '/open-artifact/callback') {
    callback = href;
    window.history.replaceState(null, '', '/open-artifact/callback');
  }
  return href;
}

export function clearRegistryLaunchLocation(): void { callback = null; }

if (typeof window !== 'undefined') registryLaunchLocation();
