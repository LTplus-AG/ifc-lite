/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Registry of available cloud storage providers. The importer UI iterates this
 * list, so adding a provider is a one-line change here plus its `/api/<id>/*`
 * routes and a `*_CLIENT_ID`/`*_SECRET` env pair.
 *
 * Google Drive is the one exception: it resolves to *one of two* strategies
 * rather than a fixed singleton. If `VITE_GOOGLE_CLIENT_ID` + `VITE_GOOGLE_API_KEY`
 * are set, the browser-only Picker path (`google-drive-browser.ts`) is used —
 * no server, no client secret, `drive.file` scope only. Otherwise it falls
 * back to the maintainer's server-side OAuth path (`google-drive.ts`). Either
 * way exactly one `id: 'google'` entry is registered, so the menu never shows
 * two confusing "Google Drive" items.
 */

import type { CloudProvider } from './types.js';
import { dropboxProvider } from './dropbox.js';
import { googleDriveProvider } from './google-drive.js';
import { createBrowserGoogleDriveProvider, loadGoogleBrowserConfig } from './google-drive-browser.js';
import { onedriveProvider } from './onedrive.js';

const googleBrowserConfig = loadGoogleBrowserConfig(import.meta.env);
const googleProvider: CloudProvider = googleBrowserConfig
  ? createBrowserGoogleDriveProvider(googleBrowserConfig)
  : googleDriveProvider;

export const cloudProviders: readonly CloudProvider[] = [
  dropboxProvider,
  googleProvider,
  onedriveProvider,
];
