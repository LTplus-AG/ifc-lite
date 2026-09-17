/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Does a relative `new URL(…, import.meta.url)` in an emitted file point at
 * something this package actually ships?
 *
 * BACKGROUND (#4895, review of #4900). The first spelling of both build steps
 * asked `existsSync(resolve(dirname(file), specifier))`, and that question is
 * not the one that matters. Three ways it answered yes for a target an npm
 * consumer never receives:
 *
 *   - `./../src/parser.worker.ts` resolves to the real source file, which
 *     exists on a developer's machine and is outside `dist`. `files` ships
 *     `dist` only, so the tarball has no such path.
 *   - `./subdir` is an existing directory. `existsSync` does not care, and a
 *     directory is not a loadable worker.
 *   - a specifier written `../x.ts`, with no leading `./`, was not matched by
 *     the pattern at all and so was never checked.
 *
 * All three were reproduced against a synthetic `dist` before this module
 * existed: the verifier reported "2 URL specifier(s) in 3 emitted file(s) all
 * resolve" and exited 0.
 *
 * Both build steps share this one answer on purpose. What has to stay
 * independent is the DECISION to rewrite versus the CHECK that the rewrite
 * landed — see verify-dist-worker-urls.mjs. Which paths count as shipped is
 * the same question in both, and two spellings of it is how #637 happened.
 *
 * WHAT IT CANNOT SEE. It is lexical: a specifier assembled at runtime from
 * variables has no literal to classify. It also reads `files` as "dist plus
 * README" rather than parsing the field, so a future narrower `files` would
 * make it too permissive; `pnpm pack` stays the ground truth.
 */

import { isAbsolute, relative, resolve } from 'node:path';

/** Every relative `new URL(…, import.meta.url)` — `./x` and `../x` alike. */
export const relativeUrlSpecifier = () =>
  /new URL\(\s*(['"])(\.\.?\/[^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;

/** The subset whose target is a TypeScript file, which tsc never emits. */
export const relativeTsUrlSpecifier = () =>
  /new URL\(\s*(['"])(\.\.?\/[^'"]+\.ts)\1\s*,\s*import\.meta\.url\s*\)/g;

/**
 * Classify one specifier. Pure: `inspect` is the only thing that would touch a
 * filesystem, so a test can drive every branch from a plain object.
 *
 * @param {object} args
 * @param {string} args.distRoot absolute path of the emitted `dist`
 * @param {string} args.fileDir absolute directory of the file holding the specifier
 * @param {string} args.specifier the relative specifier, as written
 * @param {(absolutePath: string) => 'file' | 'directory' | 'missing'} args.inspect
 * @returns {'shipped' | 'outside-dist' | 'not-a-file' | 'missing'}
 */
export function classifyTarget({ distRoot, fileDir, specifier, inspect }) {
  const target = resolve(fileDir, specifier);
  const withinDist = relative(distRoot, target);

  // An empty result means the target IS distRoot; `..` or an absolute path
  // means it climbed out of it. Neither is a file inside the tarball.
  if (withinDist === '' || withinDist.startsWith('..') || isAbsolute(withinDist)) {
    return 'outside-dist';
  }

  const kind = inspect(target);
  if (kind === 'missing') return 'missing';
  if (kind !== 'file') return 'not-a-file';
  return 'shipped';
}

/** One line a reader can act on, per verdict. */
export const REASONS = {
  'outside-dist': 'resolves outside dist/, so the published tarball does not contain it',
  'not-a-file': 'resolves to a directory, not a loadable file',
  missing: 'does not exist in dist/',
};
