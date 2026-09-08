/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CLI's own version, read from its `package.json` at startup.
 *
 * Kept out of `index.ts` so the read can be tested without executing the
 * CLI's top-level `main()`.
 */

import { readFileSync } from 'node:fs';

/** Reported when `package.json` can't be read — deliberately not a plausible
 * version number, so a bug report never carries a fabricated one. */
export const UNKNOWN_VERSION = '0.0.0-unknown';

/**
 * Read `version` from the package manifest at `pkgPath`.
 *
 * A failure here is a broken install (missing/unreadable/corrupt
 * `package.json`), not a normal condition: it used to fall back to a
 * hard-coded `'0.4.0'`, which by 0.22.0 meant `--version` confidently
 * reported a version the binary had not been for eighteen releases. Report
 * the failure on stderr and return a value that reads as unknown.
 */
export function readCliVersion(pkgPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    process.stderr.write(
      `Warning: ${pkgPath} declares no "version"; reporting ${UNKNOWN_VERSION}.\n`,
    );
    return UNKNOWN_VERSION;
  } catch (err) {
    process.stderr.write(
      `Warning: could not read the CLI version from ${pkgPath} ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `reporting ${UNKNOWN_VERSION}.\n`,
    );
    return UNKNOWN_VERSION;
  }
}
