/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5942 — the card reports what the drape measured (spec §15.4): the covered
 * fraction, the CRS path and the ground sample distance; and it says, before
 * anything is fetched, that tile drapes are viewer-only.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { cleanup, render } from '@/test/render.js';
import type { FederatedModel } from '@/store';
import type { TerrainImageryDrape } from '@/lib/terrain-imagery/drape-state.js';
import { orthoTerrainDocument } from '@/lib/terrain-imagery/synthetic-orthophoto.fixture.js';
import { TerrainImageryCard } from './TerrainImageryCard.js';

function drape(overrides: Partial<TerrainImageryDrape> = {}): TerrainImageryDrape {
  return {
    sourceName: 'ortho.png', source: 'file', placement: 'world file', imageCrs: 'EPSG:2056', imageCrsSource: 'ortho.prj',
    projection: { crs: 'EPSG:2056', origin: [2_600_000, 1_200_000], axisU: [1, 0], axisV: [0, 1], extent: [100, 50], imageSize: [200, 100], deviationPx: 0 },
    reprojected: false, totalVertices: 105, coveredVertices: 67, displayedGsd: 0.5, flatColour: [0.42, 0.62, 0.32], textureId: -1,
    ...overrides,
  };
}

function model(terrainImagery?: TerrainImageryDrape, document = orthoTerrainDocument()): FederatedModel {
  return { id: 'terrain', name: 'terrain.xml', landXmlDocument: document, ...(terrainImagery ? { terrainImagery } : {}) } as FederatedModel;
}

afterEach(cleanup);

describe('TerrainImageryCard (#5942)', () => {
  it('reports the covered fraction, the image CRS and the displayed ground sample distance', () => {
    const text = render(<TerrainImageryCard model={model(drape())} />).textContent ?? '';
    assert.match(text, /63\.8 % \(67 of 105 vertices\)/);
    assert.match(text, /EPSG:2056/);
    assert.match(text, /0\.5 meter per pixel/);
    assert.match(text, /ortho\.png/);
  });

  it('names a reprojection and marks a tile drape as never exported', () => {
    const text = render(<TerrainImageryCard model={model(drape({
      source: 'tiles', sourceName: 'tile.example tiles, zoom 17', imageCrs: 'EPSG:3857', reprojected: true,
    }))} />).textContent ?? '';
    assert.match(text, /EPSG:3857, reprojected to EPSG:2056/);
    assert.match(text, /viewer only, never exported/);
  });

  it('explains how to drape when nothing is, and why it cannot on a terrain with no CRS', () => {
    const withCrs = render(<TerrainImageryCard model={model()} />).textContent ?? '';
    assert.match(withCrs, /Drop a GeoTIFF, or a PNG\/JPEG with its world file/);
    assert.match(withCrs, /Drape tiles/);
    cleanup();
    const noCrs = orthoTerrainDocument();
    noCrs.coordinateSystem = undefined;
    const without = render(<TerrainImageryCard model={model(undefined, noCrs)} />).textContent ?? '';
    assert.match(without, /declares no coordinate system/);
    assert.doesNotMatch(without, /Drape tiles/, 'no tile form where nothing can be placed');
  });
});
