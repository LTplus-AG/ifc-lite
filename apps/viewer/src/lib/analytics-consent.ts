/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Browser-local choice shared by explicit events and PostHog's own captures. */
const OPT_OUT_KEY = 'ifc-lite:analytics-opt-out';

function readStoredOptOut(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(OPT_OUT_KEY) === 'true';
  } catch (error) {
    console.warn('[analytics] could not read opt-out setting', error);
    return false;
  }
}

let optedOut = readStoredOptOut();

export function isAnalyticsOptedOut(): boolean {
  return optedOut;
}

export function persistAnalyticsOptOut(value: boolean): void {
  optedOut = value;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(OPT_OUT_KEY, String(value));
  } catch (error) {
    console.warn('[analytics] could not persist opt-out setting', error);
  }
}
