/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Count a declared write node once as soon as a lane or removal succeeds.
 * Its mutations remain observable even if a later lane aborts or fails. */
export function onceSuccessfulWrite(writes: boolean, record: () => void): () => void {
  let recorded = false;
  return () => {
    if (!writes || recorded) return;
    recorded = true;
    record();
  };
}
