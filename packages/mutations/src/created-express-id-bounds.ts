/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Scan creation claims without reading entity payloads or counting source deletions. */
export function createdExpressIdBounds(claims: Iterable<number>[], ceiling: number): { lowest: number; highest: number } {
  let lowest = Infinity, highest = 0;
  for (const ids of claims) for (const id of ids) {
    if (id < lowest) lowest = id;
    if (id <= ceiling && id > highest) highest = id;
  }
  return { lowest: lowest === Infinity ? 0 : lowest, highest };
}
