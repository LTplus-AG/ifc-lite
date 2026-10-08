/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { activePerfFlags } from './flags.js';

/**
 * The perf-flag arm a field event ran under (#6961), as one groupable string:
 * `default` when every M7 flag is at its default, else the non-default flags
 * as sorted `id=value` pairs joined by `,`. The field verdict (#6961)
 * splits the paired ratio by exactly this string.
 */
export function perfFlagArm(active: Record<string, string> = activePerfFlags()): string {
  const pairs = Object.keys(active).sort().map((id) => `${id}=${active[id]}`);
  return pairs.length > 0 ? pairs.join(',') : 'default';
}
