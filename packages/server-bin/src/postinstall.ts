#!/usr/bin/env node

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Postinstall script - downloads binary during npm install.
 *
 * This is optional and runs with "|| true" to not fail installation
 * if download fails. Users can manually download later with:
 *   npx @ifc-lite/server-bin download
 */

import { downloadBinary, isBinaryCached } from './binary.js';
import { getPlatformInfo, getPlatformDescription } from './platform.js';

async function main() {
  // Skip if IFC_LITE_SKIP_DOWNLOAD is set
  if (process.env.IFC_LITE_SKIP_DOWNLOAD) {
    console.log('[ifc-lite-server] Skipping binary download (IFC_LITE_SKIP_DOWNLOAD is set)');
    return;
  }

  // Skip if already cached
  if (await isBinaryCached()) {
    console.log('[ifc-lite-server] Binary already cached, skipping download');
    return;
  }

  try {
    const platformInfo = getPlatformInfo();
    console.log(`[ifc-lite-server] Downloading binary for ${getPlatformDescription(platformInfo)}...`);

    await downloadBinary((downloaded, total) => {
      if (total > 0) {
        const percent = Math.round((downloaded / total) * 100);
        process.stdout.write(`\r[ifc-lite-server] Downloading: ${percent}%`);
      }
    });

    console.log('\n[ifc-lite-server] Binary downloaded successfully!');
  } catch (error) {
    // Don't fail installation, just warn
    console.warn(
      `\n[ifc-lite-server] Warning: Failed to download binary.\n` +
      `Error: ${error instanceof Error ? error.message : String(error)}\n` +
      `You can download manually later with: npx @ifc-lite/server-bin download`
    );
  }
}

main();
