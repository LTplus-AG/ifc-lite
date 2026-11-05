/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

export function mergeEnglishEntries(target: Record<string, unknown>, incoming: Readonly<Record<string, unknown>>, source: string): void {
  for (const key of Object.keys(incoming)) {
    assert.ok(!Object.hasOwn(target, key), `${source}: duplicate English catalogue key ${key}`);
  }
  Object.assign(target, incoming);
}
