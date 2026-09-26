/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';

/** Load the #5813 primitive inside a test assertion so its absence is a red test. */
export async function loadDialogs() {
  const dialogs = await import('../components/ui/confirm-dialog.js').catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  });
  assert.ok(dialogs, 'the themed dialog host must exist');
  return dialogs;
}
