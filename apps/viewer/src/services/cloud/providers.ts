/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Registry of available cloud storage providers. The importer UI iterates this
 * list, so adding a provider is a one-line change here plus its `/api/<id>/*`
 * routes and a `*_CLIENT_ID`/`*_SECRET` env pair.
 *
 * Google Drive is the one provider that isn't a fixed singleton: it's built
 * by `createGoogleDriveProvider`, which resolves the live Picker-based
 * provider when `VITE_GOOGLE_CLIENT_ID` + `VITE_GOOGLE_API_KEY` are present at
 * build time, or a stub that explains what's missing when they aren't (see
 * `google-drive-browser.ts`). There is no server-side Google flow anymore —
 * Dropbox and OneDrive still use the shared OAuth-code-exchange path.
 */

import type { CloudProvider } from './types.js';
import { dropboxProvider } from './dropbox.js';
import { createGoogleDriveProvider, loadGoogleBrowserConfig } from './google-drive-browser.js';
import { onedriveProvider } from './onedrive.js';

const googleProvider: CloudProvider = createGoogleDriveProvider(loadGoogleBrowserConfig(import.meta.env));

export const cloudProviders: readonly CloudProvider[] = [
  dropboxProvider,
  googleProvider,
  onedriveProvider,
];
