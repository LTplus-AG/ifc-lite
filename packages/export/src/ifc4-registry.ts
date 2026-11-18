/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The parser's IFC4 pin registry, read on first use.
 *
 * `getSchemaRegistryForVersion('IFC4')` returns the very object
 * `SCHEMA_REGISTRY` is. Reading the constant instead would keep it in every
 * bundle that loads this package, and a kept constant is decoded when its
 * chunk loads (the viewer's startup chunks, which must not decode schema
 * tables: `apps/viewer/scripts/check-schema-tables-lazy.mjs`). Memoised so a
 * default parameter does not re-run the lookup's emptiness check per call.
 */

import { getSchemaRegistryForVersion, type SchemaRegistry } from '@ifc-lite/parser';

let ifc4: SchemaRegistry | undefined;

/** The IFC4 registry `SCHEMA_REGISTRY` names, decoded on first call. */
export function ifc4Registry(): SchemaRegistry {
  if (ifc4 === undefined) ifc4 = getSchemaRegistryForVersion('IFC4');
  return ifc4;
}
