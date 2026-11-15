/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every georeferencing source a file carries, losers included.
 *
 * {@link extractGeoreferencing} answers "where does this model go?" and so
 * returns one winner: the IFC4 entities, else `ePSet_MapConversion`, else the
 * IfcSite reference point. A diagnosis needs the losers too, because the most
 * common real defects are disagreements between sources the winner hides (an
 * IfcSite left at an authoring tool's default beside a correct map
 * conversion, an IFC4 entity and an IFC2x3 property set with different
 * offsets, two map conversions with different values).
 *
 * Read-only and additive: every reader here is the one the winner path uses,
 * so a source is read exactly as it would be read if it won.
 */

import type { IfcEntity } from './entity-extractor.js';
import {
  extractIfc4Georeferencing,
  extractLegacySiteGeoreference,
  MAP_CONVERSION_TYPE_NAMES,
  type GeoreferenceInfo,
  type MapConversion,
} from './georef-extractor.js';
import { extractMapConversion } from './georef-map-conversion.js';
import { extractEPSetMapConversion } from './georef-epset.js';

export interface GeoreferenceCandidates {
  /**
   * The IFC4+ entity reading: the first IfcMapConversion (or
   * IfcMapConversionScaled), else the first IfcRigidOperation, with its target
   * CRS. Exactly {@link extractIfc4Georeferencing}'s result, so
   * `hasGeoreference: false` means the file carries none of these.
   */
  entities: GeoreferenceInfo;
  /** Every IfcMapConversion / IfcMapConversionScaled the file carries, in file order. Only the first is applied. */
  mapConversions: MapConversion[];
  /** The IFC2x3 `ePSet_MapConversion` / `ePSet_ProjectedCRS` reading, even when the IFC4 entities win. */
  ePSetMapConversion: GeoreferenceInfo | null;
  /** The first IfcSite with RefLatitude and RefLongitude (`source: 'siteLocation'`), even when another source wins. */
  siteLocation: GeoreferenceInfo | null;
  /** How many operation and CRS entities the file holds. */
  counts: {
    mapConversion: number;
    rigidOperation: number;
    projectedCRS: number;
    geographicCRS: number;
  };
  /** The source {@link extractGeoreferencing} would pick, or undefined when nothing places the model. */
  winner: GeoreferenceInfo['source'];
}

/**
 * Read every georeferencing source in `entities`. Same input shape as
 * {@link extractGeoreferencing}; the caller decides how much of the file to
 * load (`extractGeoreferenceCandidatesOnDemand` loads exactly what this reads).
 */
export function extractGeoreferenceCandidates(
  entities: Map<number, IfcEntity>,
  entitiesByType: Map<string, number[]>,
): GeoreferenceCandidates {
  const ifc4 = extractIfc4Georeferencing(entities, entitiesByType);
  const ePSet = extractEPSetMapConversion(entities, entitiesByType);
  const site = extractLegacySiteGeoreference(entities, entitiesByType);

  const mapConversionIds = MAP_CONVERSION_TYPE_NAMES.flatMap((typeName) => entitiesByType.get(typeName) ?? []);
  const mapConversions: MapConversion[] = [];
  for (const id of mapConversionIds) {
    const entity = entities.get(id);
    const conversion = entity ? extractMapConversion(entity) : null;
    if (conversion) mapConversions.push(conversion);
  }

  // The winner rule of `extractGeoreferencing` / `withGeoreferenceFallbacks`.
  const winner = ifc4.hasGeoreference ? ifc4.source : (ePSet?.source ?? site?.source);

  return {
    entities: ifc4,
    mapConversions,
    ePSetMapConversion: ePSet,
    siteLocation: site,
    counts: {
      mapConversion: mapConversionIds.length,
      rigidOperation: (entitiesByType.get('IfcRigidOperation') ?? []).length,
      projectedCRS: (entitiesByType.get('IfcProjectedCRS') ?? []).length,
      geographicCRS: (entitiesByType.get('IfcGeographicCRS') ?? []).length,
    },
    winner,
  };
}
