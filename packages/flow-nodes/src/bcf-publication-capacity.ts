/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { record, refuse } from './bcf-publication-codec.js';

export const DIGEST_SLOTS = 4_096;
const code = (error: unknown) => record(error) ? error.code : undefined;
export function capacityDigest(value: unknown): string {
  if (!record(value) || value.version !== 2 || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
    || Object.keys(value).some(k => !['version', 'digest'].includes(k))) refuse('invalid digest capacity record');
  return value.digest;
}

/** Monotonic, never-deleted slots. Same-digest racers converge on the same first slot. */
export async function reserveDigest(directory: string, digest: string,
  publish: (directory: string, filename: string, value: unknown) => Promise<void>,
  read: (directory: string, filename: string) => Promise<unknown>, sync: (directory: string) => Promise<void>): Promise<void> {
  for (let slot = 0; slot < DIGEST_SLOTS; slot += 1) {
    const filename = `slot-${slot}.json`;
    try {
      if (capacityDigest(await read(directory, filename)) === digest) { await sync(directory); return; }
      continue;
    } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    try { await publish(directory, filename, { version: 2, digest }); }
    catch (error) {
      if (code(error) !== 'EEXIST') throw error;
      // A competing same-digest claim won this exact first available slot.
      if (capacityDigest(await read(directory, filename)) !== digest) continue;
    }
    // A failed fsync leaves this immutable claim authoritative and reusable, never deleted.
    await sync(directory);
    return;
  }
  refuse('digest bucket capacity reached before sending; existing receipts remain readable');
}
