/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

/** Restore source bytes after synchronous qualification, preserving both failures. */
export function withRestoredSource(path, operation) {
  const original = readFileSync(path), errors = [];
  let result;
  try {
    result = operation();
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      writeFileSync(path, original);
      assert.deepEqual(readFileSync(path), original, `Restoration failed: ${path}`);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `Qualification and restoration failed: ${path}`);
  return result;
}
