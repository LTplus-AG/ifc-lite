/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Generated outputs belong to one invocation; disabled phases must not expose old results. */
export async function resetRunOutputs(out) {
  for (const name of ['probes.json', 'exercises.json', 'shots', 'frames', 'artifacts']) {
    await rm(join(out, name), { recursive: true, force: true });
  }
}
