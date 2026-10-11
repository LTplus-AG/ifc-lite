/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Discovery of the buildingSMART IDS conformance corpus for the conformance
 * dashboard (IDS-125). The corpus is CC BY-ND 4.0 and only ever read.
 *
 * A case is one `<group>/<prefix>-<name>.ids`, its paired `.ifc` and the
 * verdict its prefix promises:
 *  - `pass-` / `fail-`: a question about the MODEL; the expected spec verdict.
 *  - `invalid-`: a question about the IDS DOCUMENT; it must be rejected.
 * The group is the corpus directory, which is the facet under test
 * (attribute, classification, entity, ids, material, partof, property,
 * restriction, tolerance).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {'pass' | 'fail' | 'invalid'} Expected */

/**
 * @typedef {object} CorpusCase
 * @property {string} id        `<group>/<file name without .ids>`
 * @property {string} group     corpus directory (facet)
 * @property {Expected} expected
 * @property {string} idsPath
 * @property {string} ifcPath   may not exist for some `invalid-` cases
 */

const PREFIXES = /** @type {const} */ (['pass', 'fail', 'invalid']);

/**
 * Every case under `root`, sorted by id. Throws on a file with an unknown
 * prefix: a convention this harness does not encode must not be skipped.
 * @param {string} root
 * @returns {CorpusCase[]}
 */
export function discoverCorpus(root) {
  if (!existsSync(root)) throw new Error(`corpus not found: ${root}`);
  /** @type {CorpusCase[]} */
  const cases = [];
  for (const group of readdirSync(root).sort()) {
    const dir = join(root, group);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.ids')) continue;
      const base = name.slice(0, -4);
      const prefix = base.split('-')[0];
      if (!PREFIXES.includes(/** @type {Expected} */ (prefix))) {
        throw new Error(`unrecognised corpus prefix: ${group}/${name}`);
      }
      cases.push({
        id: `${group}/${base}`,
        group,
        expected: /** @type {Expected} */ (prefix),
        idsPath: join(dir, name),
        ifcPath: join(dir, `${base}.ifc`),
      });
    }
  }
  return cases;
}
