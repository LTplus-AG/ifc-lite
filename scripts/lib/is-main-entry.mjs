/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Is this module the script node was actually asked to run?
 *
 * The obvious spelling is `import.meta.url === `file://${process.argv[1]}``,
 * and it is wrong in two ways that both fail SILENTLY -- the module simply
 * falls through, the process exits 0 having done nothing, and a caller reads
 * that as success:
 *
 *   - a path containing a space arrives percent-encoded in `import.meta.url`
 *     and raw in `argv[1]`, so the strings never match;
 *   - a symlinked checkout resolves one side and not the other.
 *
 * Comparing resolved PATHS rather than URLs closes both at once, with no
 * encoding step to get wrong. `realpathSync` throws if the path has vanished
 * between spawn and now, so fall back to a plain resolve rather than letting
 * an entry-point check take the process down.
 *
 * Callers MUST pass their own `import.meta.url`. Reading it inside this module
 * would resolve to this file and answer for the wrong script -- which is the
 * one way to reintroduce the bug while appearing to fix it.
 *
 * @param {string} moduleUrl the calling module's `import.meta.url`
 * @returns {boolean}
 */
export function isMainEntry(moduleUrl) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const self = fileURLToPath(moduleUrl);
  try {
    return realpathSync(self) === realpathSync(invoked);
  } catch {
    return self === resolve(invoked);
  }
}
