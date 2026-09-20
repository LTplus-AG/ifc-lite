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
    const declared = spatialMetadataFromLandXml('<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2"><CoordinateSystem horizontalDatum="EPSG:2056" verticalDatum="EPSG:5729"/></LandXML>');
    assert.deepEqual(declared, { format: 'landxml', horizontalId: 'EPSG:2056', verticalId: 'EPSG:5729', provenance: 'LandXML CoordinateSystem' });
    assert.equal(spatialMetadataFromLandXml('<LandXML/>').horizontalId, undefined);
    assert.equal(spatialMetadataFromLandXml('<LandXML xmlns="urn:vendor"><CoordinateSystem horizontalDatum="EPSG:2056" verticalDatum="EPSG:5729"/></LandXML>').horizontalId, undefined);
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

  it('makes missing vertical metadata explicit-unknown so federation cannot carry height through', () => {
    const reference = spatialReferenceFromSourceMetadata({ format: 'las', horizontalId: 'EPSG:2056', provenance: 'LAS VLR 2112' });
    assert.equal(reference.confidence, 'unknown');
    assert.equal(reference.vertical, undefined);
  });

});
