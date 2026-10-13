/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reached only by the root unused-locals gate's bounded worker pool.
import { countViolations } from './unused-locals-measure.mjs';

const [root, dir] = process.argv.slice(2);
if (!root || !dir || process.argv.length !== 4) {
  throw new Error('unused-locals worker requires one root and one package');
}
console.log(JSON.stringify({ dir, ...countViolations(root, dir) }));
