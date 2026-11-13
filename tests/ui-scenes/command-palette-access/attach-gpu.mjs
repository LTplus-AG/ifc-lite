/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// NODE_OPTIONS preload for the unchanged UX browser fixture (#8947).
// Resolve Playwright from this checkout, never from a machine scratch helper.
import { chromium } from '@playwright/test';

if (process.env.IFC_GPU_CDP_URL) {
  // Installed Playwright 1.64's CDP browser.close() closes its transport, not
  // Browser.close on the managed Chrome process. Each spec owns its contexts.
  chromium.launch = async () => chromium.connectOverCDP(process.env.IFC_GPU_CDP_URL);
}
