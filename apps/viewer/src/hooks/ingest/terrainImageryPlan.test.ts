/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5942 — the drape, end to end through the REAL LandXML mesh builder: parse
 * the synthetic terrain the way the loader does (`parseLandXmlGeometry`, with
 * its survey-scale origin shift), then plan the drape from the rendered meshes
 * and check the marked feature against the marked pixel.
 *
 * The fixture is synthetic (see its header). It proves the invariant — the
 * feature vertex and the feature pixel coincide — and certifies no producer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { parseLandXmlGeometry } from './landXmlIngest.js';
import { planTerrainDrape, terrainCrsOf, type TerrainDrapeSource } from './terrainImageryPlan.js';
import { drapeProjection, type DrapeProjection } from '@/lib/terrain-imagery/drape-projection.js';
import { parseWorldFile } from '@/lib/terrain-imagery/georaster.js';
import { FEATURE, ORTHO, orthoTerrainDocument, orthoWorldFile } from '@/lib/terrain-imagery/synthetic-orthophoto.fixture.js';

function orthoProjection(): DrapeProjection {
  const affine = parseWorldFile(orthoWorldFile());
  assert.ok(affine.ok);
  const projection = drapeProjection(
    { width: ORTHO.width, height: ORTHO.height, affine: affine.value, crs: ORTHO.crs, crsSource: 'test', placement: 'world file' },
    ORTHO.crs,
  );
  assert.ok(projection.ok);
  return projection.value;
}

function loaded(pointOrder: 'northing-first' | 'easting-first' = 'northing-first'): TerrainDrapeSource {
  const payload = parseLandXmlGeometry(orthoTerrainDocument(pointOrder));
  return {
    document: payload.semanticDocument,
    meshes: payload.geometryResult.meshes,
    coordinateInfo: payload.geometryResult.coordinateInfo,
  };
}

/** Vertices whose UV falls in the marked pixel, with their rendered world position. */
function markedVertices(source: TerrainDrapeSource, meshes: ReadonlyArray<{ index: number; uvs: Float64Array }>) {
  const hits: Array<{ east: number; north: number }> = [];
  const shift = source.coordinateInfo.originShift;
  for (const { index, uvs } of meshes) {
    const mesh = source.meshes[index];
    for (let vertex = 0; vertex < uvs.length / 2; vertex += 1) {
      const col = Math.floor(uvs[vertex * 2] * ORTHO.width);
      const row = Math.floor((1 - uvs[vertex * 2 + 1]) * ORTHO.height);
      if (col !== ORTHO.marked.col || row !== ORTHO.marked.row) continue;
      const origin = mesh.origin ?? [0, 0, 0];
      hits.push({
        east: mesh.positions[vertex * 3] + origin[0] + shift.x,
        north: -(mesh.positions[vertex * 3 + 2] + origin[2] + shift.z),
      });
    }
  }
  return hits;
}

describe('planTerrainDrape over the real LandXML mesh path (#5942)', () => {
  it('drapes the feature vertex on the marked pixel, within the image\'s ground sample distance', () => {
    const source = loaded();
    // Survey-scale coordinates: the loader shifted the render frame, so this
    // exercises the frame recovery rather than an identity.
    assert.equal(source.coordinateInfo.hasLargeCoordinates, true);
    const plan = planTerrainDrape(source, orthoProjection());
    assert.ok(plan.ok, plan.ok ? '' : plan.reason);
    const hits = markedVertices(source, plan.value.meshes);
    assert.equal(hits.length, 1, 'exactly one rendered vertex drapes the marked pixel');
    const distance = Math.hypot(hits[0].east - FEATURE.easting, hits[0].north - FEATURE.northing);
    assert.ok(distance < ORTHO.gsd, `the vertex draping the marked pixel is ${distance} m from the feature`);
  });

  it('reports the covered fraction over distinct TIN vertices', () => {
    const plan = planTerrainDrape(loaded(), orthoProjection());
    assert.ok(plan.ok);
    // 13 × 8 grid + the feature = 105 vertices. On the image (E 2 600 000–
    // 2 600 100, N 1 200 000–1 200 050): 11 columns × 6 rows + the feature.
    assert.equal(plan.value.totalVertices, 105);
    assert.equal(plan.value.coveredVertices, 67);
  });

  it('refuses an easting-first terrain under the correctly placed image — it lands nowhere near it', () => {
    // At LV95 magnitudes the transpose is 1.4 km-scale off (E ≈ 1.2 M, N ≈ 2.6 M),
    // so the mirrored terrain covers none of the image: a refusal, never a quiet drape.
    const plan = planTerrainDrape(loaded('easting-first'), orthoProjection());
    assert.equal(plan.ok, false);
    assert.match(plan.ok ? '' : plan.reason, /covers no vertex/);
  });

  it('recovers the source frame through the pre-alignment snapshot of a federated model', () => {
    const source = loaded();
    // Federation re-bakes the vertices into the anchor's frame and zeroes the
    // origins; the snapshot keeps what they were.
    const aligned: MeshData[] = source.meshes.map((mesh) => {
      const origin = mesh.origin ?? [0, 0, 0];
      const positions = new Float32Array(mesh.positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        positions[i] = mesh.positions[i] + origin[0] + 123.4;
        positions[i + 1] = mesh.positions[i + 1] + origin[1];
        positions[i + 2] = mesh.positions[i + 2] + origin[2] - 56.7;
      }
      return { ...mesh, positions, origin: undefined };
    });
    const snapshot = {
      positions: source.meshes.map((mesh) => mesh.positions),
      origins: source.meshes.map((mesh) => mesh.origin),
      coordinateInfo: source.coordinateInfo,
    };
    const withSnapshot = planTerrainDrape({ ...source, meshes: aligned, preAlignment: snapshot }, orthoProjection());
    assert.ok(withSnapshot.ok);
    assert.equal(withSnapshot.value.coveredVertices, 67);
    // Without it the moved vertices match no TIN point: refused, not guessed.
    const withoutSnapshot = planTerrainDrape({ ...source, meshes: aligned }, orthoProjection());
    assert.equal(withoutSnapshot.ok, false);
    assert.match(withoutSnapshot.ok ? '' : withoutSnapshot.reason, /source frame cannot be recovered/);
  });

  it('refuses a terrain with no declared EPSG coordinate system', () => {
    assert.match(terrainCrsOf({}).ok ? '' : (terrainCrsOf({}) as { reason: string }).reason, /declares no coordinate system/);
    const named = terrainCrsOf({ coordinateSystem: { horizontalDatum: 'CH1903+ / LV95' } });
    assert.equal(named.ok, false);
    assert.match(named.ok ? '' : named.reason, /not an explicit EPSG code/);
    const source = loaded();
    const plan = planTerrainDrape({ ...source, document: { ...source.document, coordinateSystem: undefined } }, orthoProjection());
    assert.equal(plan.ok, false);
  });
});
