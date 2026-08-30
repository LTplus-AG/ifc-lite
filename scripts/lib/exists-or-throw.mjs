/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { statSync } from 'node:fs';

/**
 * `existsSync` with the one answer it refuses to guess.
 *
 * `existsSync` returns false for EVERY failure, not only ENOENT: EACCES on a
 * locked directory, ENOTDIR when a FILE sits where a directory belongs, EIO on
 * a bad disk. A gate that discovers packages with it therefore reads "I could
 * not open this" as "this is not here", drops the package from its audit, and
 * prints OK — the absence-reads-as-success defect, one stage earlier than the
 * walk it usually gets fixed in.
 *
 * Measured, twice, against gates carrying real packages:
 *   check-test-glob-coverage.mjs, one `chmod 000` package with a test script:
 *     `OK (1 packages audited, 0 unrun test files)`, exit 0 (#3194 follow-up).
 *   check-test-wiring.mjs, two packages, one of them `chmod 000`:
 *     `OK (2 packages, ...)` became `OK (1 packages, ...)`, exit 0 — and with
 *     the locked package holding test files and NO `test` script, the run that
 *     had exited 1 naming it exited 0 saying nothing (#3347).
 *
 * SHARED rather than copied, on the same footing as `stripYamlComments` in
 * ./server-bin-targets-parse.mjs, which check-test-wiring.mjs and
 * check-server-bin-targets.mjs already import from one place. The refusal is a
 * pure filesystem predicate plus one sentence of prose, and a sentence kept in
 * two files is held together by nothing but someone remembering to edit both.
 *
 * `fail` is injected because each gate prefixes its own name and throws its own
 * FailError; nothing about the refusal itself is softened to make it shareable.
 *
 * @param {string} path
 * @param {string} what human-readable role of `path`, e.g. 'package manifest'
 * @param {(message: string) => never} fail the caller's own failure reporter
 * @returns {boolean} true if it exists, false ONLY if it definitely does not
 */
export function existsOrThrow(path, what, fail) {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    fail(
      `cannot read ${what} ${path}: ${err.code || err.message}. ` +
        'Refusing to treat an unreadable path as an absent one -- that is how a ' +
        'package drops out of the audit without anyone noticing.',
    );
    // Unreachable with either gate's `fail`, which throws. Kept because the one
    // way this helper could go soft is a caller whose `fail` returns: falling
    // out of the catch would hand back `undefined`, the caller would read it as
    // "absent", and the drop this exists to stop would be back with the error
    // message still printed above it.
    throw err;
  }
}
