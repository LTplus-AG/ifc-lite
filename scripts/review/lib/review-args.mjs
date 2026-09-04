/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ARGV PARSING for post-review.mjs (module-size budget, the seam #3798 opened).
 * Extracted rather than allowlisted: #3798 brought post-review.mjs back under the
 * house 400-line rule and DELETED its allowlist row, and adding the row back to
 * fit two new flags would undo that ratchet on the first change after it.
 *
 * The flag TABLES and the value-consuming loop only. Which combinations are
 * legal stays in `main()`, next to the code that acts on them.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostReviewError } from './post-review-error.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG = join(HERE, '..', '..', 'review-posted.config.json');

/**
 * A Map, not an object literal, for the reason the sibling gate records: a
 * `{...}[name]` lookup reaches Object.prototype, so `--constructor x` returns a
 * truthy key, sails past the `!key` guard and writes a junk property instead of
 * refusing.
 */
const FLAGS = new Map([
  ['--pr', 'pr'],
  ['--repo', 'repo'],
  ['--sha', 'sha'],
  ['--findings', 'findings'],
  ['--author', 'author'],
  ['--config', 'config'],
  // The human half of a nothing-to-review marker. Optional, and PASSED THROUGH
  // `sanitizeBody`: it reaches the comment body, and the only caller that sets
  // it interpolates a build-input message that carries a PR-chosen file path.
  ['--reason', 'reason'],
]);

/** Flags that take NO value. Kept separate so the value-consuming loop stays strict. */
const BOOL_FLAGS = new Map([
  ['--nothing-to-review', 'nothingToReview'],
  // #3775. The SAME marker-only path, for the case where the reviewer DID run,
  // was retried once, and every finding it produced was refused by validation.
  // It writes `verdict=dropped`, NOT `nothing-to-review`: the gate reads the
  // latter as COVERED, and covering a head nothing vouches for would seal it --
  // the first all-dropped run would be the last, and a harness regression
  // dropping every finding on every PR would go quiet.
  ['--all-findings-dropped', 'allFindingsDropped'],
]);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = {
    pr: null,
    repo: process.env.GITHUB_REPOSITORY || null,
    sha: null,
    findings: null,
    author: null,
    config: DEFAULT_CONFIG,
    reason: null,
    nothingToReview: false,
    allFindingsDropped: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const boolKey = BOOL_FLAGS.get(argv[i]);
    if (boolKey) {
      out[boolKey] = true;
      continue;
    }
    const key = FLAGS.get(argv[i]);
    if (!key) throw new PostReviewError('BAD_ARGS', `Unrecognised argument \`${argv[i]}\`.`);
    const v = argv[i + 1];
    if (v === undefined) throw new PostReviewError('BAD_ARGS', `\`${argv[i]}\` needs a value.`);
    out[key] = v;
    i += 1;
  }
  return out;
}
