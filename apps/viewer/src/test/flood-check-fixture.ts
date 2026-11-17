/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests only: a real `@ifc-lite/flood-check` result, computed by the package's
 * pure check (no network) for a 20 m x 10 m building on flat ground at 500 m.
 * The map shows flow depth 0.1-0.25 m along the south façade and nothing
 * elsewhere. The south door (express id 1) sits at the terrain, so it is
 * exposed; the north door (express id 2) has transparent ground in front and
 * no source of other buildings, so the check withholds "no runoff mapped".
 */

import {
  BAFU_CLASSES,
  CELL_NO_RUNOFF,
  checkFloodExposure,
  toPropertySets,
  type CandidateFact,
  type ClassifiedHazardRaster,
  type ModelFacts,
} from '@ifc-lite/flood-check';
import type { FloodCheckOutcomeData } from '@/store/slices/floodCheckSlice';

const E0 = 2_680_800;
const N0 = 1_251_430;
const GROUND = 500;

function door(expressId: number, name: string, x: number, y: number): CandidateFact {
  return {
    expressId, globalId: `door-${expressId}`, name, ifcClass: 'IfcDoor', predefinedType: 'DOOR', category: 'door',
    position: { x, y }, level: GROUND, levelBasis: 'placement-origin', levelIsUpperEstimate: false, storeyId: 10, selectedBecause: 'fixture',
  };
}

function raster(): ClassifiedHazardRaster {
  const cell = 1, x0 = E0 - 10, y0 = N0 - 10, w = 40, h = 30;
  const shallow = BAFU_CLASSES.findIndex((c) => c.id === 'depth-0.1-0.25') + 1;
  const cells = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const y = y0 + h * cell - (row + 0.5) * cell;
      cells[row * w + col] = y < N0 ? shallow : CELL_NO_RUNOFF;
    }
  }
  return {
    crs: 'EPSG:2056', width: w, height: h, cellSize: cell, origin: { x: x0, y: y0 + h * cell }, cells, classes: BAFU_CLASSES,
    counts: { total: w * h, classified: 0, noRunoff: 0, unclassifiedOpaque: 0, unclassifiedTranslucent: 0, byClass: {} },
    provenance: {
      providerId: 'fixture', datasetId: 'ch.bafu.gefaehrdungskarte-oberflaechenabfluss', datasetTitle: { de: 'Fixture', en: 'Fixture' },
      datasetDate: '2018-05-22', retrievedAt: '2026-11-16T10:00:00.000Z', requestUrl: 'https://wms.geo.admin.ch/fixture',
      attribution: 'fixture attribution', licence: 'fixture licence', returnPeriod: { de: 'Wiederkehr', en: 'return' },
      limits: [{ de: 'Grenze', en: 'limit' }], disclaimer: { de: 'Hinweis', en: 'note' },
    },
    covers: 'everywhere',
  };
}

export function floodCheckFixture(): FloodCheckOutcomeData {
  const facts: ModelFacts = {
    georeference: {
      crs: 'EPSG:2056', verticalDatum: null, source: 'mapConversion', eastings: E0, northings: N0, orthogonalHeight: GROUND,
      rotationDegrees: 0, horizontalScale: 1, scaleBasis: 'units-agree', lengthUnitScale: 1,
    },
    footprint: { rings: [[{ x: E0, y: N0 }, { x: E0 + 20, y: N0 }, { x: E0 + 20, y: N0 + 10 }, { x: E0, y: N0 + 10 }]], source: 'given', fromElements: [] },
    storeys: [{ expressId: 10, globalId: 's10', name: 'EG', level: GROUND }],
    groundStorey: { expressId: 10, level: GROUND, basis: 'given' },
    candidates: [door(1, 'South door', E0 + 10, N0), door(2, 'North door', E0 + 10, N0 + 10)],
    spaces: [], skipped: [], warnings: [],
  };
  const terrain = { crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', verticalAccuracy: 0.5, heightAt: () => GROUND };
  const result = checkFloodExposure(facts, raster(), terrain);
  const { site, elements } = toPropertySets(result, BAFU_CLASSES);
  return {
    result, siteSet: site, elementSets: new Map(elements.map((e) => [e.expressId, e.propertySet])),
    requests: 3, bytes: 12_345, finishedAt: Date.parse('2026-11-16T10:00:05Z'),
  };
}
