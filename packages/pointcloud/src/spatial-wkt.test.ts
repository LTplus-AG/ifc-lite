/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { extractWktSpatialMetadata } from './spatial-wkt.js';

describe('WKT spatial metadata (#5048)', () => {
  it('retains native projected axes and foot units from WKT2', () => {
    const wkt = 'COMPOUNDCRS["county",PROJCRS["grid",BASEGEOGCRS["base",ID["EPSG",4326]],AXIS["Northing",north,ORDER[1]],AXIS["Easting",east,ORDER[2]],LENGTHUNIT["US survey foot",0.3048006096012192],ID["EPSG",2236]],VERTCRS["height",AXIS["Gravity-related height",up],LENGTHUNIT["foot",0.3048],ID["EPSG",6360]]]';
    expect(extractWktSpatialMetadata(wkt)).toEqual({
      horizontalId: 'EPSG:2236', verticalId: 'EPSG:6360',
      axes: ['north', 'east', 'up'],
      horizontalUnitToMetres: 0.3048006096012192,
      verticalUnitToMetres: 0.3048,
    });
  });

  it('does not fabricate axes or units when WKT leaves them absent', () => {
    expect(extractWktSpatialMetadata('PROJCS["grid",AUTHORITY["EPSG","2056"]]'))
      .toEqual({ horizontalId: 'EPSG:2056' });
    expect(extractWktSpatialMetadata('PROJCS["grid",LENGTHUNIT["foot",0.3048],AUTHORITY["EPSG","2236"]]'))
      .toEqual({ horizontalId: 'EPSG:2236', horizontalUnitToMetres: 0.3048 });
  });
});
