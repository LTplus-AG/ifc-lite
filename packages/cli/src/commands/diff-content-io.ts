/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * File-level I/O for `ifc-lite diff --by-content`: reading the two input
 * models (and unwrapping a possible `.ifcZIP` container), and refusing to run
 * at all when an output path would overwrite one of them. Split out of
 * `diff-content.ts` for size.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Stats } from 'node:fs';
import { unwrapIfcZipView } from '@ifc-lite/parser';
import { fatal } from '../output.js';

/**
 * Refuse to run at all if `--identity-out` names one of the two input models.
 *
 * The sidecar is a JSON document. Writing it over an IFC file destroys the
 * user's model, and a mistyped or shell-completed path is all it takes — the
 * two arguments right before it are IFC paths. So this is checked first, and
 * the command exits without reading, comparing, or writing anything.
 *
 * Two independent tests, because a path string is not a file:
 *
 * 1. Resolved paths are equal. Catches `./v1.ifc` vs `v1.ifc` vs `sub/../v1.ifc`
 *    with no filesystem access, and is the whole answer on a platform where
 *    `stat` reports no usable inode.
 * 2. The output already exists AND is the same file as an input, by device +
 *    inode. This is the exhaustive test: it catches a symlink, a hard link, a
 *    bind mount, and `V1.IFC` on a case-insensitive filesystem — every way two
 *    different strings can name one file. It is also sufficient on its own for
 *    the destructive case, because a path that does not resolve to an existing
 *    file cannot be overwriting an input: the inputs must exist to be read.
 *
 * `--identity-in` and `--identity-out` naming the SAME sidecar is not checked
 * here, because that is the carry-forward workflow this feature is built around
 * (read the accepted claims, write back the ones that still held).
 */
export async function refuseOverwritingAnInput(options: {
  basePath: string;
  headPath: string;
  identityOut?: string;
  lineageOut?: string;
}): Promise<void> {
  for (const [flag, target] of [
    ['--identity-out', options.identityOut],
    ['--lineage-out', options.lineageOut],
  ] as const) {
    if (target === undefined) continue;
    const out = resolve(target);
    const outStat = await statOrUndefined(target);
    for (const [label, input] of [
      ['base model', options.basePath],
      ['head model', options.headPath],
    ] as const) {
      if (resolve(input) !== out && !isSameFile(outStat, await statOrUndefined(input))) continue;
      fatal(
        `${flag} ${target} is the ${label} (${input}). ` +
          'Writing there would overwrite the input file.',
      );
    }
  }
}

async function statOrUndefined(path: string): Promise<Stats | undefined> {
  // A missing or unreadable path cannot be an input file being overwritten;
  // reading the models is what reports it, with its own message.
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

function isSameFile(a: Stats | undefined, b: Stats | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Read one of the two input models, reporting a missing or unreadable path the
 * way the rest of the command reports problems rather than throwing a raw
 * `ENOENT` stack at the user — the same treatment `readVerifiedSidecar` gives
 * the sidecar.
 */
export async function readModel(path: string): Promise<Uint8Array> {
  try {
    return await readFile(path);
  } catch (error) {
    return fatal(`Cannot read ${path}: ${(error as Error).message}`);
  }
}

/**
 * Unwrap a possible `.ifcZIP` container into its STEP bytes, reporting a
 * corrupt zip the way the rest of the command reports problems (see
 * {@link readModel}) rather than throwing a raw error. Ordinary `.ifc` bytes
 * pass through unchanged (cheap magic-byte check — `unwrapIfcZipView`).
 *
 * Called once per file and the result reused by both the parser and (when
 * `--geometry` runs) the wasm mesh pass — passing the ORIGINAL, possibly
 * zipped bytes to the mesh pass would feed it a zip container instead of STEP
 * text (issue #4956 review).
 */
export async function unwrapModel(bytes: Uint8Array, label: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await unwrapIfcZipView(bytes));
  } catch (error) {
    return fatal(`Cannot read ${label}: ${(error as Error).message}`);
  }
}
