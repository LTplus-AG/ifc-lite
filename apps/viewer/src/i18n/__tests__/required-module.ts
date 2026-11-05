/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

// #8890: production reverts must reach an assertion, including newly added modules.
export async function requiredModule<T>(load: () => Promise<T>, behavior: string): Promise<T> {
  let loaded: T | undefined;
  try { loaded = await load(); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error)
      || !['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(String(error.code))) throw error;
  }
  assert.ok(loaded, behavior);
  return loaded;
}
