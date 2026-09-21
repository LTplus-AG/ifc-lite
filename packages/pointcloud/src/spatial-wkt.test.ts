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

  it('reads WKT2 unit ownership from individual projected and vertical axes (#5048)', () => {
    const wkt = 'COMPOUNDCRS["county",PROJCRS["grid",AXIS["Northing",north,ORDER[1],LENGTHUNIT["US survey foot",0.3048006096012192]],AXIS["Easting",east,ORDER[2],LENGTHUNIT["US survey foot",0.3048006096012192]],ID["EPSG",2236]],VERTCRS["height",AXIS["H",up,ORDER[1],LENGTHUNIT["US survey foot",0.3048006096012192]],ID["EPSG",6360]]]';
    expect(extractWktSpatialMetadata(wkt)).toEqual({
      horizontalId: 'EPSG:2236', verticalId: 'EPSG:6360',
      axes: ['north', 'east', 'up'],
      horizontalUnitToMetres: 0.3048006096012192,
      verticalUnitToMetres: 0.3048006096012192,
    });
  });

  it('refuses conflicting AXIS-owned units instead of defaulting to metres (#5048)', () => {
    const wkt = 'COMPOUNDCRS["county",PROJCRS["grid",AXIS["Northing",north,LENGTHUNIT["foot",0.3048]],AXIS["Easting",east,LENGTHUNIT["US survey foot",0.3048006096012192]],ID["EPSG",2236]],VERTCRS["height",AXIS["H",up,LENGTHUNIT["foot",0.3048]],ID["EPSG",6360]]]';
    expect(extractWktSpatialMetadata(wkt)).toEqual({
      horizontalId: 'EPSG:2236', verticalId: 'EPSG:6360', axes: ['north', 'east', 'up'],
      verticalUnitToMetres: 0.3048,
    });
  });

  it('does not fabricate axes or units when WKT leaves them absent', () => {
    expect(extractWktSpatialMetadata('PROJCS["grid",AUTHORITY["EPSG","2056"]]'))
      .toEqual({ horizontalId: 'EPSG:2056' });
    expect(extractWktSpatialMetadata('PROJCS["grid",LENGTHUNIT["foot",0.3048],AUTHORITY["EPSG","2236"]]'))
      .toEqual({ horizontalId: 'EPSG:2236', horizontalUnitToMetres: 0.3048 });
  });

  it('does not borrow nested base CRS authorities, units, or axes (#5048)', () => {
    const custom = 'PROJCS["custom",GEOGCS["base",AUTHORITY["EPSG",4326],UNIT["degree",0.0174532925199433]],AXIS["E",EAST],AXIS["N",NORTH],UNIT["metre",1]]';
    expect(extractWktSpatialMetadata(custom)).toEqual({
      axes: ['east', 'north', 'up'], horizontalUnitToMetres: 1,
    });
  });

  it('does not treat a WKT1 geographic angular UNIT as metres (#5048)', () => {
    const geographic = 'GEOGCS["WGS 84",DATUM["WGS_1984"],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';
    expect(extractWktSpatialMetadata(geographic)).toEqual({ horizontalId: 'EPSG:4326' });
  });
});
