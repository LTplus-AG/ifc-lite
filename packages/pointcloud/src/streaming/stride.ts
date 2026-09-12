/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Normalize an untrusted numeric stride without narrowing it to 32 bits. */
export function normalizePointStride(value: number): number {
  const finite = Number.isFinite(value) ? value : 1;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(finite)));
}
