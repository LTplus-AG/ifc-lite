#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guard: the viewer's startup chunks decode no schema table when they load.
 *
 * The generated schema tables (`@ifc-lite/data`'s entity, attribute,
 * property-set and data-type tables, the codegen schema registries) and the
 * sets derived from them are compact strings decoded on first use through a
 * getter. Each also has an exported constant, written
 * `/* @__PURE__ *\/ eagerSchemaTable('ifc-lite-eager-table:<NAME>', getX)`:
 * the bundler drops it when nothing references it, and keeps it, decoded as
 * soon as its chunk loads, as soon as anything does. A kept constant keeps
 * its marker string, so a startup chunk that carries one decodes that table at
 * boot. Code on the startup path reads the getters instead.
 *
 * No chunk at all may keep one, not only the static startup graph: a chunk
 * that is imported dynamically can still be evaluated at boot (the entry may
 * call `import()` at once, as bootstrap.tsx does for the idle warm), and a
 * walk of the static graph cannot tell those imports from deferred ones. Every
 * reader uses a getter, so a kept constant anywhere is a defect.
 *
 * Vacuity: some chunk must carry the schema tables themselves (the encoded
 * IFC4 registry names its schema, `IFC4_ADD2_TC1`), or the check looked at a
 * build without them. That the minifier keeps a marker beside a kept constant
 * was shown by this gate's first real run, which caught five (#9865). Runs at the tail of the viewer's
 * `build` script, like check-structural-writes-lazy.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../../../scripts/lib/is-main-entry.mjs';
import { relative, resolve as resolvePath } from 'node:path';
import { lazyChunks, startupChunks } from './startup-chunks.mjs';

/** The prefix every eager schema-table constant's marker starts with. */
export const SCHEMA_TABLE_MARKER = 'ifc-lite-eager-table:';

/** Text the encoded IFC4 registry always carries: its schema name. */
export const SCHEMA_TABLE_PAYLOAD = 'IFC4_ADD2_TC1';

const REMEDY = 'A module on the startup path references an eager schema-table constant (ENTITIES_*, IFC_DATA_TYPES, '
  + 'SCHEMA_REGISTRY, a derived *_TYPES set, ...), so it is decoded when the viewer boots. Read its getter instead '
  + '(getEntitiesIfc4x3(), getSchemaRegistryForVersion(...), getProductTypes(), ...); the marker after the colon names the constant.';

export async function checkSchemaTablesLazy(dist) {
  const directory = resolvePath(dist);
  const eager = await startupChunks(directory);
  let tablesSeen = false;
  for (const [file, code] of eager) {
    const at = code.indexOf(SCHEMA_TABLE_MARKER);
    if (at >= 0) {
      const name = code.slice(at, at + 96).match(/^[\w:-]+/)?.[0] ?? SCHEMA_TABLE_MARKER;
      throw new Error(`Startup chunk ${relative(directory, file)} contains ${name}. ${REMEDY}`);
    }
    if (code.includes(SCHEMA_TABLE_PAYLOAD)) tablesSeen = true;
  }
  let lazyCount = 0;
  for await (const [file, code] of lazyChunks(directory, eager)) {
    lazyCount++;
    const at = code.indexOf(SCHEMA_TABLE_MARKER);
    if (at >= 0) {
      const name = code.slice(at, at + 96).match(/^[\w:-]+/)?.[0] ?? SCHEMA_TABLE_MARKER;
      throw new Error(`Chunk ${relative(directory, file)} (loaded on demand) contains ${name}. A dynamically imported chunk can still be evaluated at boot, so no chunk may keep an eager schema-table constant. ${REMEDY}`);
    }
    if (code.includes(SCHEMA_TABLE_PAYLOAD)) tablesSeen = true;
  }
  if (!tablesSeen) {
    throw new Error(`No chunk in ${directory} carries the schema tables (${SCHEMA_TABLE_PAYLOAD}), so this check proves nothing. Did the generated registry change its schema name, or did the build drop the tables?`);
  }
  return { eager: [...eager.keys()].map((file) => relative(directory, file)).sort(), lazyCount };
}

if (isMainEntry(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  const { eager, lazyCount } = await checkSchemaTablesLazy(directory);
  console.log(`schema tables lazy: no eager schema-table constant in ${eager.length} startup chunks or ${lazyCount} on-demand chunks`);
}
