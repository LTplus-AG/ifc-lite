/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { execFileSync } from 'node:child_process';
import { isMainEntry } from '../lib/is-main-entry.mjs';

/** #6979 includes the scene.finalize readiness migration, after #6977. */
export const MINIMUM_SPAN_REVISION = '272ebd8615d038dc20dd8aec4e3bb88d1acf9fa7';

/** Pin source identity before starting a browser. This is an ancestry check,
 * not a claim that arbitrary supplied dist bytes were built from the revision.
 * Frozen builds still need their independently retained build/hash receipt. */
export function requireSpanSource(repository, revision, minimum = MINIMUM_SPAN_REVISION) {
  if (typeof revision !== 'string' || !revision || revision.startsWith('-')) {
    throw new Error('A source revision is required for every cold A/B build (#7005)');
  }
  try {
    const git = args => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const head = git(['rev-parse', '--verify', `${revision}^{commit}`]);
    const floor = git(['rev-parse', '--verify', `${minimum}^{commit}`]);
    git(['merge-base', '--is-ancestor', floor, head]);
    return head;
  } catch (cause) {
    throw new Error(`Cold A/B source must include #6979 (${minimum}); fetch its history and choose a newer base/branch (#7005)`, { cause });
  }
}

if (isMainEntry(import.meta.url)) {
  console.log(requireSpanSource(process.argv[2], process.argv[3]));
}
