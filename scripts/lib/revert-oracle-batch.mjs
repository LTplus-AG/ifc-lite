/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';

/** Repeated mutations are independent experiments, never a combined patch.
 * A --test after a mutation belongs to that mutation. Leading --test flags
 * apply to every case, preserving the single-mutation CLI's ordering freedom.
 */
export function mutationInvocations(argv) {
  const common = [], cases = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mutation') cases.push([arg, argv[++i]]);
    else if (arg === '--test') (cases.at(-1) ?? common).push(arg, argv[++i]);
    else {
      common.push(arg);
      if (['--base', '--head', '--only', '--root', '--timeout-ms'].includes(arg)) common.push(argv[++i]);
    }
  }
  return cases.map((args) => [...common, ...args]);
}

export function runMutationBatch(argv, script) {
  const cases = mutationInvocations(argv);
  if (cases.length < 2) return null;
  let exit = 0;
  for (const [index, args] of cases.entries()) {
    console.log(`[revert-oracle] mutation ${index + 1}/${cases.length}`);
    const run = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
    exit = Math.max(exit, run.status ?? 3);
    // Never launch another mutation over a possibly unrestored checkout.
    if (run.error || run.signal || run.status === 5) break;
  }
  return exit;
}
