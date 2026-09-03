/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** CI blocks real misses and broken baselines; an honest inconclusive is advisory. */
export function ciExitCode(result) {
  if (result === 'OBSERVED') return 0;
  if (result === 'UNOBSERVED') return 1;
  if (result === 'INCONCLUSIVE') return 0;
  return 3;
}
