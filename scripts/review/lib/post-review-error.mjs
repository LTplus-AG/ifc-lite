/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one error class `post-review.mjs` and its split-out siblings all throw.
 * Its own file (module-size budget, #3795) so every sibling can throw it
 * without importing back through `post-review.mjs` -- which would be
 * circular, since that file imports from `lib/review-findings.mjs`,
 * `lib/review-comments.mjs` and `lib/review-summary.mjs`.
 */

export class PostReviewError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}
