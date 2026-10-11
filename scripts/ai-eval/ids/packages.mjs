/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Load the built workspace packages the IDS eval needs (`@ifc-lite/ids`,
 * `@ifc-lite/parser`, `@ifc-lite/data`) from their `dist/`.
 *
 * The root package does not depend on workspace packages, so scripts reach
 * them by path, the same way `scripts/generate-server-attr-indices.mjs` does.
 * A missing `dist/` throws with the build command. It never skips: a skipped
 * scorer would report nothing and look the same as a passing one. CI's
 * node-tests job downloads the build output before it runs these tests.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './e2-dataset.mjs';

const BUILD_HINT = 'run `pnpm turbo build --filter=@ifc-lite/ids...` first';

async function importDist(root, relative) {
  const path = join(root, relative);
  if (!existsSync(path)) throw new Error(`${relative} is not built; ${BUILD_HINT}`);
  return import(pathToFileURL(path).href);
}

/**
 * @param {string} [root]
 * @returns {Promise<{
 *   parseIDS: Function, validateIDS: Function, auditIDSDocument: Function,
 *   createDataAccessor: Function, IfcParser: new () => { parseColumnar(buffer: ArrayBuffer): Promise<any> },
 * }>}
 */
export async function loadIdsToolchain(root = REPO_ROOT) {
  const [ids, bridge, parser] = await Promise.all([
    importDist(root, 'packages/ids/dist/index.js'),
    importDist(root, 'packages/ids/dist/bridge/index.js'),
    importDist(root, 'packages/parser/dist/index.js'),
  ]);
  for (const [name, value] of Object.entries({
    parseIDS: ids.parseIDS, validateIDS: ids.validateIDS, auditIDSDocument: ids.auditIDSDocument,
    createDataAccessor: bridge.createDataAccessor, IfcParser: parser.IfcParser,
  })) {
    // A stale or half-built dist imports cleanly and exports nothing.
    if (typeof value !== 'function') throw new Error(`built package is missing ${name}; ${BUILD_HINT}`);
  }
  return {
    parseIDS: ids.parseIDS,
    validateIDS: ids.validateIDS,
    auditIDSDocument: ids.auditIDSDocument,
    createDataAccessor: bridge.createDataAccessor,
    IfcParser: parser.IfcParser,
  };
}

/** `findEntity` / `findPropertySet` / `getPropertySets` from `@ifc-lite/data`. */
export async function loadSchemaData(root = REPO_ROOT) {
  const data = await importDist(root, 'packages/data/dist/index.js');
  for (const name of ['findEntity', 'findPropertySet', 'getPropertySets']) {
    if (typeof data[name] !== 'function') throw new Error(`@ifc-lite/data is missing ${name}; ${BUILD_HINT}`);
  }
  return { findEntity: data.findEntity, findPropertySet: data.findPropertySet, getPropertySets: data.getPropertySets };
}
