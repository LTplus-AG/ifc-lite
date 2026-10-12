/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolve } from 'node:path';

/** Actual fresh-process worker entry; launched, never read as assertion input.
 * Keep executable path discovery separate from runtime journal byte assertions
 * (#7374). The source-text gate deliberately overtaints unknown disk reads when
 * an unrelated executable-source filename also appears in the test's literals.
 */
export const BCF_PUBLICATION_PROBE_PATH = resolve('src/test/bcf-publication-probe.mjs');
