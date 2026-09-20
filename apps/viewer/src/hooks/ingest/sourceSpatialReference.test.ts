/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  spatialMetadataFromE57Xml,
  spatialMetadataFromLandXml,
  spatialMetadataFromLasVlrs,
  spatialReferenceFromSourceMetadata,
} from './sourceSpatialReference.js';

describe('non-IFC source spatial metadata (#5048)', () => {
  it('accepts only explicit LandXML CoordinateSystem EPSG declarations', () => {
    const declared = spatialMetadataFromLandXml({ coordinateSystem: { horizontalDatum: 'EPSG:2056', verticalDatum: 'EPSG:5729' } });
    assert.deepEqual(declared, { format: 'landxml', horizontalId: 'EPSG:2056', verticalId: 'EPSG:5729', provenance: 'LandXML CoordinateSystem' });
    assert.equal(spatialMetadataFromLandXml({}).horizontalId, undefined);
    // Namespace filtering is performed by the bounded Rust parser; this
    // adapter consumes only its structured CoordinateSystem result.
    assert.equal(spatialMetadataFromLandXml({ coordinateSystem: {} }).horizontalId, undefined);
  });

  it('reads an E57 coordinateMetadata WKT and leaves absent metadata unknown', () => {
    const declared = spatialMetadataFromE57Xml('<e57Root><coordinateMetadata>PROJCRS["LV95",ID["EPSG",2056]],VERTCRS["LN02",ID["EPSG",5729]]</coordinateMetadata></e57Root>');
    assert.equal(declared.horizontalId, 'EPSG:2056');
    assert.equal(declared.verticalId, 'EPSG:5729');
    assert.equal(spatialMetadataFromE57Xml('<e57Root/>').horizontalId, undefined);
  });

  it('reads LAS WKT VLRs and refuses to guess when no CRS VLR is present', () => {
    const bytes = new Uint8Array(512);
    const view = new DataView(bytes.buffer);
    view.setUint16(94, 227, true);
    view.setUint32(100, 1, true);
    bytes.set(new TextEncoder().encode('LASF_Projection'), 229);
    view.setUint16(245, 2112, true);
    const wkt = new TextEncoder().encode('PROJCRS["UTM",ID["EPSG",32632]],VERTCRS["EGM",ID["EPSG",5773]]');
    view.setUint16(247, wkt.length, true);
    bytes.set(wkt, 281);
    const declared = spatialMetadataFromLasVlrs(bytes, 'las');
    assert.equal(declared.horizontalId, 'EPSG:32632');
    assert.equal(declared.verticalId, 'EPSG:5773');
    assert.equal(spatialMetadataFromLasVlrs(new Uint8Array(227), 'laz').horizontalId, undefined);
  });

  it('uses a CRS node authority rather than nested base IDs and gives WKT2 precedence (#5048)', () => {
    const bytes = new Uint8Array(1024);
    const view = new DataView(bytes.buffer);
    view.setUint16(94, 227, true);
    view.setUint32(100, 2, true);
    const encoder = new TextEncoder();
    const write = (offset: number, id: number, value: string): number => {
      bytes.set(encoder.encode('LASF_Projection'), offset + 2);
      view.setUint16(offset + 18, id, true);
      const encoded = encoder.encode(value);
      view.setUint16(offset + 20, encoded.length, true);
      bytes.set(encoded, offset + 54);
      return offset + 54 + encoded.length;
    };
    const next = write(227, 2111, 'PROJCS["old",AUTHORITY["EPSG","2056"]]');
    write(next, 2112, 'COMPOUNDCRS["x",PROJCRS["new",BASEGEOGCRS["base",ID["EPSG",4326]],ID["EPSG",2056]],VERTCRS["h",ID["EPSG",5729]]]');
    const declared = spatialMetadataFromLasVlrs(bytes, 'las');
    assert.equal(declared.horizontalId, 'EPSG:2056');
    assert.equal(declared.verticalId, 'EPSG:5729');
    assert.equal(declared.provenance, 'LAS VLR 2112');
  });

  it('retains declared LAS WKT axis order and horizontal/vertical foot units (#5048)', () => {
    const bytes = new Uint8Array(1024);
    const view = new DataView(bytes.buffer);
    view.setUint16(94, 227, true);
    view.setUint32(100, 1, true);
    bytes.set(new TextEncoder().encode('LASF_Projection'), 229);
    view.setUint16(245, 2112, true);
    const wkt = new TextEncoder().encode('COMPOUNDCRS["county",PROJCRS["grid",AXIS["Northing",north,ORDER[1]],AXIS["Easting",east,ORDER[2]],LENGTHUNIT["US survey foot",0.3048006096012192],ID["EPSG",2236]],VERTCRS["height",AXIS["H",up],LENGTHUNIT["foot",0.3048],ID["EPSG",6360]]]');
    view.setUint16(247, wkt.length, true);
    bytes.set(wkt, 281);
    const reference = spatialReferenceFromSourceMetadata(spatialMetadataFromLasVlrs(bytes, 'las'));
    assert.deepEqual(reference.source, {
      axes: ['north', 'east', 'up'],
      horizontalUnitToMetres: 0.3048006096012192,
      verticalUnitToMetres: 0.3048,
    });
  });

  it('makes missing vertical metadata explicit-unknown so federation cannot carry height through', () => {
    const reference = spatialReferenceFromSourceMetadata({ format: 'las', horizontalId: 'EPSG:2056', provenance: 'LAS VLR 2112' });
    assert.equal(reference.confidence, 'unknown');
    assert.equal(reference.vertical, undefined);
  });

});
