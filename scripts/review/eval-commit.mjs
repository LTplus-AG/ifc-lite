/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';

export class EvalCommitError extends Error {}

/** Ensure a pinned squash-merged PR head is available for `git show`. */
export function ensureEvalCommit(sha, {
  exec = execFileSync,
  cwd = process.cwd(),
  remote = 'origin',
} = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) {
    throw new EvalCommitError(`Eval case head ${JSON.stringify(sha)} is not a 40-hex commit id.`);
  }
  const object = `${sha}^{commit}`;
  try {
    exec('git', ['cat-file', '-e', object], { cwd, stdio: 'ignore' });
    return { fetched: false };
  } catch {
    // A full clone still omits an unreachable squash-merged branch tip. GitHub
    // retains these objects, and fetching the exact committed id retrieves only
    // the evidence this fixture pins rather than the repository's whole history.
  }
  try {
    exec('git', ['fetch', '--no-tags', '--depth=1', remote, sha], { cwd, stdio: 'ignore' });
    exec('git', ['cat-file', '-e', object], { cwd, stdio: 'ignore' });
  } catch (error) {
    throw new EvalCommitError(
      `Eval case head ${sha} is unavailable after an exact fetch; refusing to score a case with no changed-file evidence.`,
      { cause: error },
    );
  }
  return { fetched: true };
}
