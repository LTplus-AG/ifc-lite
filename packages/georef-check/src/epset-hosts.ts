/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which spatial entities the IFC2X3 `ePSet_MapConversion` /
 * `ePSet_ProjectedCRS` sets are attached to. The buildingSMART "User Guide
 * for Geo-referencing in IFC" (v2.0, 2020, §5.1: "For the IFC2x3
 * implementation the ePSets are linked to ifcProject") and IfcOpenShell
 * (`api/georeference/add_georeferencing.py` writes them on IfcProject,
 * `util/geolocation.py` reads them only there) agree; a set on IfcSite is
 * read by ifc-lite but not by IfcOpenShell-based tools.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { EntityReader } from './coordinates.js';

/** The classes searched for a host, in the casing the type index uses. */
const HOST_TYPES: ReadonlyArray<[string, string]> = [['IFCPROJECT', 'IfcProject'], ['IFCSITE', 'IfcSite'], ['IFCBUILDING', 'IfcBuilding']];

/**
 * IfcPascalCase classes of the entities any of `psetIds` is attached to,
 * from the parser's entity → property-set map. Undefined when the store has
 * no such map (the hosts are then unknown, not absent).
 */
export function ePSetHostTypes(store: IfcDataStore, reader: EntityReader, psetIds: readonly number[]): string[] | undefined {
  const map = store.onDemandPropertyMap;
  if (!map || psetIds.length === 0) return undefined;
  const wanted = new Set(psetIds);
  const hosts = new Set<string>();
  for (const [stepType, name] of HOST_TYPES) {
    for (const id of reader.idsOfType(stepType)) {
      if ((map.get(id) ?? []).some((pset) => wanted.has(pset))) hosts.add(name);
    }
  }
  return [...hosts];
}
