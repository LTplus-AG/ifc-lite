/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One fail-closed `gh` invoker, because there were four.
 *
 * `check-coderabbit-review.mjs`, `lib/pr-green-sweep.mjs`,
 * `check-pr-review-signal.mjs` and `check-issue-queue.mjs` each grew their own
 * copy of this function, with three different `maxBuffer` values and three
 * different error vocabularies. This is the fifth caller, so it gets extracted
 * instead. The existing four are deliberately NOT migrated here: that would
 * widen a gate PR into a refactor of four unrelated gates, and each of them has
 * its own error class that its own tests assert on. Migrating them is a separate
 * change; this file exists so the count stops growing.
 *
 * THE ONE RULE: every failure throws. A `gh` call that cannot be made, exits
 * non-zero, or returns unparseable output must never be reported as an empty
 * result, because an empty result and a permissions failure are indistinguishable
 * downstream -- and "the API returned nothing" reading as "there is nothing" is
 * the absence-reads-as-success defect one layer below where it usually gets
 * caught.
 */

import { spawnSync } from 'node:child_process';

/** 128 MiB: the largest of the four copies' buffers, since truncation here is silent. */
const MAX_BUFFER = 128 * 1024 * 1024;

export class GhError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Run `gh` and parse its stdout as JSON, or throw.
 *
 * @param {string[]} args   argv for `gh`
 * @param {string} what     human phrase naming what is being fetched, for messages
 * @param {Function} [ErrorClass] caller's error class; defaults to GhError. Takes
 *   `(reason, message)` so a caller's own catch can keep one error type.
 */
export function gh(args, what, ErrorClass = GhError) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (r.error) {
    throw new ErrorClass(
      'GH_UNAVAILABLE',
      `Could not spawn \`gh\` to fetch ${what}: ${r.error.message}. Without it this gate cannot ` +
        'read its own input, and an unread input is not a clean one.',
    );
  }
  if (r.status !== 0) {
    throw new ErrorClass(
      'GH_ERROR',
      `\`gh ${args.join(' ')}\` exited ${r.status} while fetching ${what}: ` +
        `${(r.stderr || '').trim() || '(no stderr)'}. A permissions failure and an empty result are ` +
        'indistinguishable from the exit code alone, so this fails.',
    );
  }
  try {
    return JSON.parse(r.stdout);
  } catch (err) {
    throw new ErrorClass(
      'GH_BAD_JSON',
      `\`gh ${args.join(' ')}\` returned unparseable output while fetching ${what}: ${err.message}`,
    );
  }
}
