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
 * Some lazy chunk must carry a marker too, or the check would pass vacuously
 * (for example, if a minifier learned to drop the marker). Runs at the tail of
 * the viewer's `build` script, like check-structural-writes-lazy.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../../../scripts/lib/is-main-entry.mjs';
import { checkLazyOnly } from './startup-chunks.mjs';

/** The prefix every eager schema-table constant's marker starts with. */
export const SCHEMA_TABLE_MARKER = 'ifc-lite-eager-table:';

const REMEDY = 'A module on the startup path references an eager schema-table constant (ENTITIES_*, IFC_DATA_TYPES, '
  + 'SCHEMA_REGISTRY, a derived *_TYPES set, ...), so it is decoded when the viewer boots. Read its getter instead '
  + '(getEntitiesIfc4x3(), getSchemaRegistryForVersion(...), getProductTypes(), ...); the marker after the colon names the constant.';

export function checkSchemaTablesLazy(directory) {
  return checkLazyOnly(directory, [{ name: 'eager schema table', signatures: [SCHEMA_TABLE_MARKER] }], REMEDY,
    'Did the eagerSchemaTable marker change, or did the bundler start dropping it?');
}

if (isMainEntry(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  const { eager, lazy } = await checkSchemaTablesLazy(directory);
  console.log(`schema tables lazy: ${eager.length} startup chunks free of eager schema tables; lazy chunks carrying one: ${lazy.join(', ')}`);
}
