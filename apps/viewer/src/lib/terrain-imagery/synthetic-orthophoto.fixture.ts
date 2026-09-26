/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A known-georeferenced synthetic orthophoto over a synthetic TIN with one
 * marked feature (#5942).
 *
 * SYNTHETIC, and stated as such: it proves the drape's invariants (the
 * feature vertex lands on the feature pixel; the half-pixel and axis-order
 * traps) and certifies no producer. The real orthophoto + TIN pair the issue
 * asks for is still owed (mapping spec §15.6 item 4).
 *
 * Numbers chosen so every claim is checkable by hand, in EPSG:2056 (LV95):
 * a 200 × 100 px image at 0.5 m, its upper-left CORNER at E 2 600 000,
 * N 1 200 050, so it spans E 2 600 000–2 600 100 and N 1 200 000–1 200 050.
 * Pixel (137, 23) is pure red; its centre is at E 2 600 068.75, N 1 200 038.25,
 * and the TIN has a vertex exactly there. The TIN reaches past the image's
 * west and south edges, so part of it is uncovered.
 */

import { encodePng } from './png-encode.js';
import type { LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics.js';

export const ORTHO = {
  crs: 'EPSG:2056',
  width: 200,
  height: 100,
  gsd: 0.5,
  upperLeftCorner: [2_600_000, 1_200_050] as const,
  marked: { col: 137, row: 23 },
} as const;

/** The marked pixel's centre — where the feature vertex is. */
export const FEATURE = {
  easting: ORTHO.upperLeftCorner[0] + (ORTHO.marked.col + 0.5) * ORTHO.gsd,
  northing: ORTHO.upperLeftCorner[1] - (ORTHO.marked.row + 0.5) * ORTHO.gsd,
  elevation: 412.5,
} as const;

/** ESRI world file: `A D B E C F`, `C`/`F` the CENTRE of the upper-left pixel. */
export function orthoWorldFile(): string {
  const { gsd, upperLeftCorner: [east, north] } = ORTHO;
  return [gsd, 0, 0, -gsd, east + gsd / 2, north - gsd / 2].map(String).join('\n');
}

/** RGBA pixels: a smooth grey-green ramp with the one red marker. */
export function orthoRgba(): Uint8Array {
  const { width, height, marked } = ORTHO;
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const at = (row * width + col) * 4;
      const isMarked = col === marked.col && row === marked.row;
      rgba[at] = isMarked ? 255 : 60 + (col % 50);
      rgba[at + 1] = isMarked ? 0 : 90 + (row % 60);
      rgba[at + 2] = isMarked ? 0 : 70;
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

/** The orthophoto as a real RGBA PNG. */
export function orthoPng(): Uint8Array {
  return encodePng(orthoRgba(), ORTHO.width, ORTHO.height);
}

/**
 * A TIN on a 10 m grid from E 2 599 990 to 2 600 110 and N 1 199 990 to
 * 1 200 060, plus the feature vertex, triangulated cell by cell. Points
 * are authored in LandXML's northing-first order, as the parser reads them.
 */
export function orthoTerrainDocument(
  pointOrder: 'northing-first' | 'easting-first' = 'northing-first',
): LandXmlTinDocument {
  const points: Array<{ sourceId: string; id: string; northing: number; easting: number; elevation: number }> = [];
  const faces: Array<readonly [string, string, string]> = [];
  const add = (id: string, easting: number, northing: number, elevation: number): void => {
    // An easting-first producer writes E first; LandXML readers take the first
    // number as the northing, so the two arrive swapped (§2.2).
    const [first, second] = pointOrder === 'northing-first' ? [northing, easting] : [easting, northing];
    points.push({ sourceId: `landxml:surface:1:point:${id}`, id, northing: first, easting: second, elevation });
  };
  const columns = 13;
  const rows = 8;
  // LandXML `<P id>` must be a positive integer (LXML009): grid point (i, j)
  // is `j · 13 + i + 1`, and the feature is 105.
  const id = (i: number, j: number): string => String(j * columns + i + 1);
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < columns; i += 1) add(id(i, j), 2_599_990 + i * 10, 1_199_990 + j * 10, 400 + i * 0.5 + j * 0.25);
  }
  for (let j = 0; j + 1 < rows; j += 1) {
    for (let i = 0; i + 1 < columns; i += 1) {
      const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
      faces.push([a, b, c], [a, c, d]);
    }
  }
  // The feature sits inside grid cell (7, 4); replace that cell's two faces
  // with a four-triangle fan around it so the vertex is part of the TIN.
  const feature = String(columns * rows + 1);
  add(feature, FEATURE.easting, FEATURE.northing, FEATURE.elevation);
  const cell = faces.findIndex(([a]) => a === id(7, 4));
  const [sw, se, ne, nw] = [id(7, 4), id(8, 4), id(8, 5), id(7, 5)];
  faces.splice(cell, 2, [sw, se, feature], [se, ne, feature], [ne, nw, feature], [nw, sw, feature]);
  return {
    format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
    capabilities: { renderableTin: true, preservedOnlySurfaces: 0, unknownExtensions: 0 },
    units: { linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false },
    coordinateSystem: { horizontalDatum: ORTHO.crs, verticalDatum: 'EPSG:5728' },
    surfaces: [{
      sourceId: 'landxml:surface:1', ordinal: 0, sourcePath: '/LandXML/Surfaces/Surface', properties: {},
      definitionProperties: {}, name: 'Existing Ground', kind: 'tin', renderState: 'rendered', points,
      sourceDataPoints: [], faces, faceSourceIds: faces.map((_, index) => `landxml:surface:1:face:${index}`),
      faceVisibility: faces.map(() => true), hiddenFaceCount: 0, boundaries: [], breaklines: [], contours: [],
    }],
    extensions: [], warnings: [], alignments: [], profiles: [], crossSections: [], crossSectionSurfaces: [],
    roadways: [], capabilityDiagnostics: [], preservedOnlyExtensions: [],
    rendering: { meshProvenance: [], surfaceCounts: [] },
  };
}

/** The same terrain as LandXML 1.2 text, as a producer would write it. */
export function orthoTerrainXml(pointOrder: 'northing-first' | 'easting-first' = 'northing-first'): string {
  const document = orthoTerrainDocument(pointOrder);
  const surface = document.surfaces[0];
  // `orthoTerrainDocument` already holds each point as a reader would parse
  // it, so the first number written is its `northing` field in both orders.
  const points = surface.points.map((point) => `<P id="${point.id}">${point.northing} ${point.easting} ${point.elevation}</P>`).join('');
  const faces = surface.faces.map(([a, b, c]) => `<F>${a} ${b} ${c}</F>`).join('');
  return `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBars" elevationUnit="meter"/></Units>
  <CoordinateSystem horizontalDatum="${ORTHO.crs}" verticalDatum="EPSG:5728"/>
  <Surfaces><Surface name="Existing Ground"><Definition surfType="TIN"><Pnts>${points}</Pnts><Faces>${faces}</Faces></Definition></Surface></Surfaces>
</LandXML>`;
}
