/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Prints `<canonical remote>/main` for the repository in the current
 * directory (`origin/main` when no remote points at LTplus-AG/ifc-lite), for
 * shell scripts that need the same base the node gates use:
 * `MAIN_REF="$(node scripts/lib/canonical-main-ref.mjs)"`.
 */

import { canonicalMainRefIn } from './canonical-remote.mjs';

process.stdout.write(`${canonicalMainRefIn(process.cwd())}\n`);
