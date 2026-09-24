/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Commands that write their result to a path given by `--out`.
 *
 * `--out` was listed under the global `Options:` block, and is not global: the
 * 21 commands not named here parse no such flag, so `info --json --out f.json`
 * wrote to stdout, created nothing and exited 0 (#5528). It is documented per
 * command instead -- each of these already shows `--out F` on its own line in
 * `Commands:` -- and passing it to any other command is refused rather than
 * swallowed.
 */
export const COMMANDS_WITH_OUT = new Set([
  'export', 'diagnose-geometry', 'extract-entities', 'anonymize', 'bcf', 'create',
  'merge', 'convert', 'rekey', 'mutate', 'generate-spaces', 'analyze', 'lod',
  'simplify', 'delivery', 'flow',
]);
