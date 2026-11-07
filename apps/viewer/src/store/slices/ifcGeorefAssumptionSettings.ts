/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** IFC federation's explicit, browser-wide height-system choice (#8042). */
export const IFC_SHARED_VERTICAL_DATUM_STORAGE_KEY = 'ifclite.ifc.shared-vertical-datum.v1';

export function loadIfcSharedVerticalDatum(): boolean {
  try {
    return typeof localStorage !== 'undefined'
      && localStorage.getItem(IFC_SHARED_VERTICAL_DATUM_STORAGE_KEY) === 'true';
  } catch (error) {
    console.warn('[ifc] Could not read the shared height system setting', error);
    return false;
  }
}

export function saveIfcSharedVerticalDatum(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(IFC_SHARED_VERTICAL_DATUM_STORAGE_KEY, String(enabled));
    }
  } catch (error) {
    console.warn('[ifc] Could not save the shared height system setting', error);
  }
}
