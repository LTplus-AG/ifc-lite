/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE ONE SPELLING OF THE PER-FINDING DROP WARNING, shared by everything that
 * writes it and everything that reads it back.
 *
 * `finding-schema.mjs` writes the label, `validate-findings.mjs`'s warning sink
 * writes the prefix in front of it, and `retry-outcome.mjs` selects those lines
 * out of the log to put them on the pull request, so a reader of a `dropped`
 * marker sees why each finding was refused.
 *
 * Spelled inline in three places, a reword in any one of them would leave the
 * marker silently carrying an EMPTY reason: the run still posts, the body just
 * stops saying why. Nothing fails, nothing logs, no gate notices. So the prefix
 * is COMPOSED from the two halves rather than written out a second time -- the
 * constant cannot describe a line the code does not emit.
 *
 * A leaf on purpose: it imports nothing, so the CLI that reads the log does not
 * pull in the validator to learn one string.
 */

/** The word every per-finding drop starts its warning with. */
export const DROPPED_LABEL = 'DROPPED';

/** What `validate-findings.mjs` prints in front of every warning. */
export const WARN_PREFIX = '⚠️  ';

/** The whole line-start, and the only thing a reader of the log should match on. */
export const DROPPED_LOG_PREFIX = `${WARN_PREFIX}${DROPPED_LABEL}`;
