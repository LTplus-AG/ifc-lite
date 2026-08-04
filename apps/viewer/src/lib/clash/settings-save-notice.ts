/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a refused clash-settings write gets reported.
 *
 * The clash slice commits detection-setting changes before it persists them
 * (see `persistSettings` in `store/slices/clashSlice.ts`), so a refused write —
 * localStorage over quota, or blocked entirely by the browser's site settings —
 * would otherwise be invisible until the setting reverted on the next reload.
 * The slice reports it once per session through here.
 *
 * The default reporter is `console.warn`, because the slice must not import a
 * React component. `ClashSettingsDialog` — the surface where these settings are
 * edited — swaps in a toast while it is mounted, so a user changing a setting
 * sees the notice rather than only the console.
 */

export type ClashSettingsSaveReporter = (message: string) => void;

const consoleReporter: ClashSettingsSaveReporter = (message) => {
  console.warn(`[clash] ${message}`);
};

let reporter: ClashSettingsSaveReporter = consoleReporter;

/**
 * Route save-failure notices to `fn` (e.g. a toast) instead of the console.
 * Returns an unregister that restores the console fallback — but only if `fn`
 * is still the active reporter, so an out-of-order unmount cannot silently
 * detach a reporter registered after it.
 */
export function setClashSettingsSaveReporter(fn: ClashSettingsSaveReporter): () => void {
  reporter = fn;
  return () => {
    if (reporter === fn) reporter = consoleReporter;
  };
}

/** Report one refused settings write. The caller owns the once-per-session gate. */
export function reportClashSettingsSaveFailure(message: string): void {
  reporter(message);
}
