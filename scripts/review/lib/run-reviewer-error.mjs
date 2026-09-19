/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A LEAF ON PURPOSE, exactly like validate-findings-error.mjs's
 * `ValidateFindingsError`. `run-reviewer.mjs`'s own credential checks
 * (checkToken/resolveTokens, ./credentials.mjs) throw this, and run-reviewer.mjs
 * re-exports it for every existing importer -- putting the class here rather
 * than in run-reviewer.mjs itself is what lets credentials.mjs import it
 * without a cycle back through the file that re-exports credentials.mjs's own
 * functions.
 */
export class RunReviewerError extends Error {
  // `stdoutExcerpt` rides separately from `message` so `runReviewerWithFailover`
  // can log it the moment THIS credential fails, before trying the next slot --
  // previously lost whenever a later credential or provider went on to succeed.
  constructor(reason, message, { stdoutExcerpt = null } = {}) {
    super(message);
    this.reason = reason;
    this.stdoutExcerpt = stdoutExcerpt;
  }
}
