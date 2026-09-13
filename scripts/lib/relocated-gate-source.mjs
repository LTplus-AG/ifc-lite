/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The source of `scripts/check-source-text-assertions.mjs` with its relative
 * imports repointed at this checkout's real files, for the tests that copy
 * the gate into a synthetic git tree and run the COPY (`--root <tmp>`).
 *
 * The copy has to be the shipped gate, not a stand-in, so the tests exercise
 * the real ceiling regex and identity check; but a temp dir has none of the
 * gate's siblings, and the detector pulls in `typescript` from this repo's
 * node_modules, which nothing outside the repo can resolve. Rewriting each
 * `./x.mjs` specifier to an absolute `file://` URL is what lets the copy run.
 * Every specifier the gate imports is listed here ONCE: three test sites used
 * to carry the detector rewrite each, and adding `./lib/module-size-git.mjs`
 * (#4536) to the gate would have broken all three in the same way -- a copy
 * that throws `ERR_MODULE_NOT_FOUND` still exits non-zero, which is exactly
 * the verdict two of those tests assert first.
 *
 * Throws when a specifier is absent from the source: a gate that stopped
 * importing one of these should drop it here in the same change, and a test
 * running against a source that never matched would be running the wrong
 * gate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The gate's relative imports, as written in its source. */
const RELATIVE_IMPORTS = ['./source-text-assertion-detect.mjs', './lib/module-size-git.mjs'];

/**
 * @param {string} gatePath   absolute path of the real gate
 * @param {string} scriptsDir absolute path of the real `scripts/` directory
 * @returns {string} the gate source with every relative import made absolute
 */
export function relocatedGateSource(gatePath, scriptsDir) {
  let source = readFileSync(gatePath, 'utf8');
  for (const specifier of RELATIVE_IMPORTS) {
    const needle = `from '${specifier}'`;
    if (!source.includes(needle)) {
      throw new Error(`${gatePath} no longer imports ${specifier}; update RELATIVE_IMPORTS`);
    }
    const target = pathToFileURL(join(scriptsDir, specifier)).href;
    source = source.replace(needle, `from ${JSON.stringify(target)}`);
  }
  return source;
}
