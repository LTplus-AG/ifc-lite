/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IFCX_LENGTH_UNIT_SCALE, type IfcxParseResult } from '@ifc-lite/ifcx';
import type { IfcDataStore } from './columnar-parser.js';
import { buildTabularDataStore } from './tabular-data-store.js';

/**
 * The slice of an IFCX parse result the data store is built from. `spatialHierarchy`
 * is only carried into the store (never read here), so it is optional — which keeps
 * the regression test from having to fabricate a full hierarchy.
 */
type IfcxParse = IfcxParseResult;
type IfcxStoreInput = Pick<
  IfcxParse,
  'fileSize' | 'parseTime' | 'strings' | 'entities' | 'properties' | 'quantities' | 'relationships' | 'georeferencing'
> & { spatialHierarchy?: IfcxParse['spatialHierarchy']; derivedEntities?: IfcxParse['derivedEntities'] };

/**
 * Build the `IfcDataStore` from the tables produced by the IFCX parser.
 *
 * The store itself is `buildTabularDataStore`'s; this names what IFCX states
 * about its file.
 */
export function buildIfcxDataStore(ifcxResult: IfcxStoreInput, buffer: ArrayBuffer): IfcDataStore {
  const georef = ifcxResult.georeferencing;
  return buildTabularDataStore(ifcxResult, {
    schemaVersion: 'IFC5',
    source: buffer,
    fileSize: ifcxResult.fileSize,
    parseTime: ifcxResult.parseTime,
    // IFCX has no IfcUnitAssignment to read: the format's unit, assumed (nothing in the file declares it).
    lengthUnitScale: IFCX_LENGTH_UNIT_SCALE,
    lengthUnitSource: 'default',
    georeferencing: georef ? {
      hasGeoreference: true, source: 'mapConversion',
      projectedCRS: { id: 0, name: georef.IfcProjectedCRS.Name, mapUnit: 'METRE', mapUnitScale: 1 },
      mapConversion: { id: 0, sourceCRS: 0, targetCRS: 0,
        eastings: georef.IfcMapConversion.Eastings,
        northings: georef.IfcMapConversion.Northings,
        orthogonalHeight: georef.IfcMapConversion.OrthogonalHeight,
        xAxisAbscissa: georef.IfcMapConversion.XAxisAbscissa,
        xAxisOrdinate: georef.IfcMapConversion.XAxisOrdinate,
        scale: georef.IfcMapConversion.Scale,
      },
    } : undefined,
  });
}
