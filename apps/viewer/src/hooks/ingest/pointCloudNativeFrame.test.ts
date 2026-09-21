/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelSpatialReference } from '@ifc-lite/geometry';
import { computePointCloudAlignment } from './pointCloudAlignment.js';
import type { ModelSpatialPlacement } from './federationAlign.js';
import { pointCloudSpatialReferenceFromMetadata, preparePointCloudSpatialLoad } from './pointCloudSpatialLoad.js';

const HORIZONTAL_FOOT = 0.3048006096012192;
const VERTICAL_FOOT = 0.3048;

test('stream metadata retains its WKT native frame (#5048)', () => {
  const wkt = 'COMPOUNDCRS["grid+height",PROJCRS["grid",CS[Cartesian,2],AXIS["north",north],AXIS["east",east],LENGTHUNIT["US survey foot",0.3048006096012192],ID["EPSG",2236]],VERTCRS["height",CS[vertical,1],AXIS["up",up],LENGTHUNIT["foot",0.3048],ID["EPSG",5703]]]';
  const reference = pointCloudSpatialReferenceFromMetadata('las', {
    horizontalId: 'EPSG:2236',
    verticalId: 'EPSG:5703',
    wkt,
    provenance: 'LAS VLR 2112',
  });
  assert.deepEqual(reference?.source, {
    axes: ['north', 'east', 'up'],
    horizontalUnitToMetres: HORIZONTAL_FOOT,
    verticalUnitToMetres: VERTICAL_FOOT,
  });
  assert.equal(reference?.sourceMetadata?.wkt, wkt);
});

test('a LAS WKT with conflicting AXIS-owned units is refused, never defaulted to metres (#5048)', () => {
  const wkt = 'COMPOUNDCRS["grid+height",PROJCRS["grid",AXIS["north",north,LENGTHUNIT["foot",0.3048]],AXIS["east",east,LENGTHUNIT["US survey foot",0.3048006096012192]],ID["EPSG",2236]],VERTCRS["height",AXIS["up",up,LENGTHUNIT["foot",0.3048]],ID["EPSG",5703]]]';
  assert.equal(pointCloudSpatialReferenceFromMetadata('las', {
    horizontalId: 'EPSG:2236', verticalId: 'EPSG:5703', wkt, provenance: 'LAS VLR 2112',
  }), undefined);
});

function reference(
  source: ModelSpatialReference['source'],
  eastings: number,
  northings: number,
  height: number,
): ModelSpatialReference {
  return {
    source,
    horizontal: { id: 'EPSG:2236' },
    vertical: { id: 'EPSG:5703' },
    localToProjected: {
      kind: 'local-projected-affine',
      eastings,
      northings,
      orthogonalHeight: height,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    },
    confidence: 'declared',
  };
}

test('scan alignment applies native WKT axis order and independent foot units (#5048)', () => {
  const source = reference({
    axes: ['north', 'east', 'up'],
    horizontalUnitToMetres: HORIZONTAL_FOOT,
    verticalUnitToMetres: VERTICAL_FOOT,
  }, 0, 0, 0);
  const placement: ModelSpatialPlacement = {
    spatialReference: reference({
      axes: ['east', 'up', 'south'],
      horizontalUnitToMetres: 1,
      verticalUnitToMetres: 1,
    }, 1_000, 2_000, 10),
  };
  const transform = computePointCloudAlignment(placement, 'mapUnit', source);
  assert.ok(transform);

  const raw = [2_003 / HORIZONTAL_FOOT, 1_002 / HORIZONTAL_FOOT, 14 / VERTICAL_FOOT] as const;
  const offset = transform.decodeOriginOffset;
  const decoded = [raw[0] - offset[0], raw[2] - offset[2], -(raw[1] - offset[1])] as const;
  const matrix = transform.alignedMatrix;
  const result = [
    matrix[0] * decoded[0] + matrix[4] * decoded[1] + matrix[8] * decoded[2] + matrix[12],
    matrix[1] * decoded[0] + matrix[5] * decoded[1] + matrix[9] * decoded[2] + matrix[13],
    matrix[2] * decoded[0] + matrix[6] * decoded[1] + matrix[10] * decoded[2] + matrix[14],
  ];
  assert.ok(Math.abs(result[0] - 2) < 1e-9, `east: ${result[0]}`);
  assert.ok(Math.abs(result[1] - 4) < 1e-9, `up: ${result[1]}`);
  assert.ok(Math.abs(result[2] + 3) < 1e-9, `south: ${result[2]}`);
  assert.deepEqual(Array.from(matrix.slice(12, 15)), [0, 0, 0]);
});

test('a sole North/East US-foot LAS normalizes to renderer East/Up/South metres on initial load (#5048)', async () => {
  const wkt = 'COMPOUNDCRS["county",PROJCRS["grid",AXIS["Northing",north,ORDER[1]],AXIS["Easting",east,ORDER[2]],LENGTHUNIT["US survey foot",0.3048006096012192],ID["EPSG",2236]],VERTCRS["height",AXIS["H",up],LENGTHUNIT["US survey foot",0.3048006096012192],ID["EPSG",6360]]]';
  const bytes = new Uint8Array(281 + wkt.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(94, 227, true);
  view.setUint32(96, bytes.length, true);
  view.setUint32(100, 1, true);
  bytes.set(new TextEncoder().encode('LASF_Projection'), 229);
  view.setUint16(245, 2112, true);
  view.setUint16(247, wkt.length, true);
  bytes.set(new TextEncoder().encode(wkt), 281);

  const prepared = await preparePointCloudSpatialLoad(new Blob([bytes]), 'las', 'mapUnit');
  assert.ok(prepared.sourceSpatialReference, 'fixture must expose its declared LAS WKT frame');
  assert.ok(prepared.alignment, 'a first LAS must normalize itself even without a prior IFC anchor');
  const matrix = prepared.alignment.alignedMatrix;
  // Raw LAS tuple is North, East, Up. The decoder uploads (North, Up, -East),
  // then this initial transform must produce renderer (East, Up, South) metres.
  const raw = [10, 20, 30] as const;
  const offset = prepared.alignment.decodeOriginOffset;
  const decoded = [raw[0] - offset[0], raw[2] - offset[2], -(raw[1] - offset[1])] as const;
  const output = [
    matrix[0] * decoded[0] + matrix[4] * decoded[1] + matrix[8] * decoded[2] + matrix[12],
    matrix[1] * decoded[0] + matrix[5] * decoded[1] + matrix[9] * decoded[2] + matrix[13],
    matrix[2] * decoded[0] + matrix[6] * decoded[1] + matrix[10] * decoded[2] + matrix[14],
  ];
  assert.deepEqual(output, [20 * HORIZONTAL_FOOT, 30 * HORIZONTAL_FOOT, -10 * HORIZONTAL_FOOT]);
});
