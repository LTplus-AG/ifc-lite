/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { appendFileSync } from 'node:fs';
import { runColdSample as productionSample } from '../../perf/browser-cold-sample.ts';

// Observe the executable's delegation without replacing the shared behavior.
export async function runColdSample(page, options) {
  appendFileSync(process.env.COLD_AB_CALLS, JSON.stringify({ fixture: options.fixturePath }) + '\n');
  return productionSample(page, options);
}
