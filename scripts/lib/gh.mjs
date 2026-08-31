/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One fail-closed `gh` invoker, and an honest count of what it consolidates.
 *
 * Against `origin/main` there are THREE prior `gh` callers, not four. An earlier
 * draft of this comment said four and named `check-issue-queue.mjs`, which exists
 * only on an unmerged sibling branch -- a justification resting on a population
 * one member short. Corrected rather than quietly dropped, because a docblock
 * that overstates its own evidence is the thing this repository's gates exist to
 * catch, and it does not stop applying to the gates themselves.
 *
 * The three, and why each is or is not migrated:
 *
 *   - `check-pr-review-signal.mjs` is byte-for-byte this function apart from a
 *     32 MiB buffer and two prose tails, and its `ReviewSignalError` already has
 *     the `(reason, message)` shape this signature takes. It is MIGRATABLE and is
 *     deliberately not migrated here: this is a gate PR, and rewriting the
 *     internals of the repo's most load-bearing CI gate belongs in its own change
 *     where its own tests are the subject. Named as a follow-up rather than left
 *     implied.
 *   - `check-coderabbit-review.mjs` uses `execFileSync` and returns a RAW STRING,
 *     with `JSON.parse` at three call sites. Migrating changes the thrown error
 *     type at each of them, so it is a behaviour change, not a lift.
 *   - `lib/pr-green-sweep.mjs` does not invoke `gh` at all. It takes an injected
 *     `gh` callable so the module stays pure, which its own docblock states as a
 *     design choice. It is STRUCTURALLY INCOMPATIBLE with a module that spawns
 *     and parses internally, and should stay that way.
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
