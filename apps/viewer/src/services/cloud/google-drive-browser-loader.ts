/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lazy loaders for the Google Identity Services (GIS) and Google Picker
 * scripts. Neither is added to `index.html` — that would run for every
 * visitor, including the vast majority who never touch the browser-only
 * Google Drive path. Both loaders are called only once the user picks
 * "Google Drive" from the cloud-import menu, and each memoizes its promise
 * so repeat calls (e.g. re-opening the dialog) reuse the same script tag.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const GAPI_SRC = 'https://apis.google.com/js/api.js';

let gisPromise: Promise<void> | null = null;
let pickerPromise: Promise<void> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
}

/** Load the GIS client library (`window.google.accounts.oauth2`). */
export function loadGoogleIdentityServices(): Promise<void> {
  if (!gisPromise) gisPromise = loadScript(GIS_SRC);
  return gisPromise;
}

/** Load the Google API loader and its `picker` module (`window.google.picker`). */
export function loadGooglePicker(): Promise<void> {
  if (!pickerPromise) {
    pickerPromise = loadScript(GAPI_SRC).then(
      () =>
        new Promise<void>((resolve, reject) => {
          const gapi = window.gapi;
          if (!gapi) {
            reject(new Error('Google API loader failed to initialize'));
            return;
          }
          gapi.load('picker', () => resolve());
        }),
    );
  }
  return pickerPromise;
}

/** Test-only: reset the memoized promises so each test starts clean. */
export function resetGoogleScriptLoadersForTest(): void {
  gisPromise = null;
  pickerPromise = null;
}
