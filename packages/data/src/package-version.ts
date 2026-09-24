/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A package's own version, read from its `package.json` at startup.
 *
 * Lives here rather than in a bin so the read can be tested without executing
 * that bin's top-level `main()`, and so the two shipped servers -- the CLI and
 * the MCP server -- cannot drift apart on how they answer `--version`.
 */

/** Reported when `package.json` can't be read — deliberately not a plausible
 * version number, so a bug report never carries a fabricated one. */
export const UNKNOWN_VERSION = '0.0.0-unknown';

/**
 * Read `version` from the package manifest at `pkgPath`.
 *
 * A failure here is a broken install (missing/unreadable/corrupt
 * `package.json`), not a normal condition. Report it on stderr and return a
 * value that reads as unknown rather than a plausible number a bug report
 * would then carry.
 *
 * Both consumers have already paid for the alternative. The CLI used to fall
 * back to a hard-coded `'0.4.0'`, which by 0.22.0 meant `--version`
 * confidently reported a version the binary had not been for eighteen
 * releases. `@ifc-lite/mcp` shipped `VERSION = '0.1.0'` as a literal and was
 * still announcing it over the wire at 0.19.0 (#5540).
 */
export function readPackageVersion(pkgPath: string): string {
  try {
    const pkg = JSON.parse(
      // Not a top-level import: this package is bundled into browser apps,
      // where `node:fs` is an empty shim (#5586). Needs Node 20.16+ or 22.3+,
      // which is what the CLI and MCP (its only callers) declare in `engines`.
      process.getBuiltinModule('node:fs').readFileSync(pkgPath, 'utf-8'),
    ) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    process.stderr.write(
      `Warning: ${pkgPath} declares no "version"; reporting ${UNKNOWN_VERSION}.\n`,
    );
    return UNKNOWN_VERSION;
  } catch (err) {
    process.stderr.write(
      `Warning: could not read the version from ${pkgPath} ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `reporting ${UNKNOWN_VERSION}.\n`,
    );
    return UNKNOWN_VERSION;
  }
}
