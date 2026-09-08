/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The compare fingerprint cache has to be keyed on the mesh content, not just
 * on the A/B model ids (#1891).
 *
 * Fingerprint extraction is the expensive part of a comparison, so the built
 * sides are cached and a scope / blacklist / matching toggle re-diffs them
 * instead of re-extracting. But federation re-alignment re-frames vertices AND
 * their world boxes IN PLACE, under the same model ids and the same
 * `geometryResult` object — so an id-only key hands the engine pre-alignment
 * boxes for post-alignment meshes, and every distance it derives is measured
 * between two coordinate frames.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { IfcParser, type IfcDataStore, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { isCurrentFor, readGeometryContentVersion } from './useCompare.js';
import { useViewerStore } from '../store/index.js';
import { buildEntityFingerprints } from '../lib/compare/buildFingerprints.js';
import { alignGeometryToReference, type ModelGeoref } from './ingest/federationAlign.js';

describe('isCurrentFor — the compare fingerprint cache key (#1891)', () => {
  const built = { baseModelId: 'a', headModelId: 'b', contentVersion: 3 };

  it('reuses fingerprints for the same pair at the same content version', () => {
    assert.equal(isCurrentFor(built, 'a', 'b', 3), true);
  });

  it('refuses to reuse them once mesh content was mutated in place', () => {
    // `geometryContentVersion` is bumped by exactly one caller — federation
    // re-alignment — and only when something actually moved. Reusing across
    // that bump is the defect: the meshes moved, the fingerprints did not.
    assert.equal(isCurrentFor(built, 'a', 'b', 4), false);
  });

  it('refuses to reuse them for a different pair', () => {
    assert.equal(isCurrentFor(built, 'a', 'c', 3), false);
    assert.equal(isCurrentFor(built, 'c', 'b', 3), false);
    // Order matters: A/B is not B/A.
    assert.equal(isCurrentFor(built, 'b', 'a', 3), false);
  });
});

describe('readGeometryContentVersion — observes the store live', () => {
  it('sees a bump that happens after it was handed to the guard', () => {
    // `buildAtCurrentVersion` calls this before AND after the extraction's
    // awaits to notice a federation re-align landing in between. Snapshotting
    // the number once instead of passing this function would make both reads
    // agree by construction and the guard could never fire.
    const before = readGeometryContentVersion();
    useViewerStore.getState().bumpGeometryContentVersion();
    const after = readGeometryContentVersion();
    assert.equal(after, before + 1, 'the reader must observe the live store');
  });
});

describe('why the content version belongs in that key', () => {
  function ifc4(body: string): string {
    return [
      'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
      "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
      'DATA;', body, 'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
  }

  async function wallStore(): Promise<IfcDataStore> {
    const bytes = new TextEncoder().encode(
      ifc4("#1=IFCWALL('0aBcDeFgHiJkLmNoPqRsTu',$,'Wall A',$,$,$,$,$,.STANDARD.);"),
    );
    return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  }

  function coordinateInfo(): CoordinateInfo {
    const zero = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    return {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: zero,
      shiftedBounds: zero,
      hasLargeCoordinates: false,
    };
  }

  function georef(eastings: number): ModelGeoref {
    return {
      mapConversion: {
        id: 1, sourceCRS: 2, targetCRS: 3, eastings, northings: 0, orthogonalHeight: 0,
        xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
      } as MapConversion,
      projectedCRS: { id: 4, name: 'EPSG:2056', mapUnitScale: 1 } as ProjectedCRS,
      lengthUnitScale: 1,
    };
  }

  function geometry(): GeometryResult {
    const corners: number[] = [];
    for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) corners.push(x, y, z);
    const mesh = {
      expressId: 1,
      positions: new Float32Array(corners),
      normals: new Float32Array(corners.length),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1],
      geometryHash: 7n,
      geometryAabb: { min: [0, 0, 0], max: [1, 1, 1] },
    } as unknown as MeshData;
    return { meshes: [mesh], totalTriangles: 1, totalVertices: 8, coordinateInfo: coordinateInfo() };
  }

  it('re-alignment moves an entity aabb while the model id stays the same', async () => {
    const store = await wallStore();
    const geom = geometry();

    const before = await buildEntityFingerprints({
      modelId: 'model-1', store, meshes: geom.meshes, idOffset: 0,
    });
    assert.equal(before.length, 1);
    assert.deepEqual(before[0].aabb?.min, [0, 0, 0]);

    await alignGeometryToReference(geom, georef(2500), georef(0));

    const after = await buildEntityFingerprints({
      modelId: 'model-1', store, meshes: geom.meshes, idOffset: 0,
    });

    // Same model id, same entity key, same geometry hash — nothing an id-keyed
    // cache could notice — yet the box has moved 2500 m. Reusing `before` here
    // is what makes the reported distance the distance between two frames.
    assert.equal(after[0].key, before[0].key);
    assert.equal(after[0].geometryHash, before[0].geometryHash);
    assert.ok(
      Math.abs((after[0].aabb?.min[0] ?? 0) - 2500) < 1e-3,
      `expected the re-framed box at 2500, got ${after[0].aabb?.min[0]}`,
    );
  });
});
