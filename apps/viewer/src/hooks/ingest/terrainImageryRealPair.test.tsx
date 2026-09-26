/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5942 real-pair acceptance (mapping spec §15.6 item 4), pinned.
 *
 * REAL data, both halves, fetched by `pnpm fixtures` (provenance in the
 * manifest rows under `landxml/imagery/`):
 *  - the terrain: a 3D-Win 6.6.4 export, buildingSMART Finland InfraModel M3
 *    `M3_Terrain`, CC BY 4.0. It declares `epsgCode="3875"` (ETRS89/GK21FIN)
 *    and carries surveyed, coded breaklines.
 *  - the image: a 320 × 280 px crop of the National Land Survey of Finland
 *    2022 colour orthophoto, sheet M3143G, 0.5 m, EPSG:3067 (ETRS-TM35FIN),
 *    CC BY 4.0 — the terrain's surveyed south-west road.
 *
 * The producer file is kept byte-exact. It is an InfraModel profile, which the
 * parser refuses as supplied (#5051: ISO-8859-1 declaration, InfraModel root
 * namespace); the test relabels ONLY that envelope in memory — the file is
 * pure ASCII, so every other byte is unchanged — and says so by assertion.
 *
 * What is proven, through the canonical load path and the real wasm parser:
 *  1. The image, reprojected TM35FIN → GK21FIN, lands every sampled TIN vertex
 *     on the pixel PROJ 9.8.1 (pyproj 3.8.0) puts it on, to 0.01 px.
 *  2. The surveyed feature and the draped image coincide within the image's
 *     ground sample distance: across the surveyed carriageway, the imaged
 *     asphalt edges sit where the surveyed pavement edges say, to within one
 *     GSD in translation.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RefObject } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fromArrayBuffer } from 'geotiff';
import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { drapeUv, groundSampleDistance, type DrapeProjection } from '@/lib/terrain-imagery/drape-projection.js';
import { GeoRasterBundle } from '@/lib/terrain-imagery/raster-bundle.js';
import { readGeoRasterBundle } from '@/lib/terrain-imagery/read-raster.js';
import { setGlobalRendererRef } from '../useBCF.js';
import { useIfcLoader } from '../useIfcLoader.js';
import { drapeRasterOnTerrains } from './terrainImageryDrape.js';
import { SurfaceSnapper } from './terrainImageryVertices.js';
import type { LandXmlPolyline } from './landXmlSemantics.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const TERRAIN = resolve(REPO_ROOT, 'tests/models/landxml/imagery/3d-win-6.6.4-m3-terrain.xml');
const ORTHO = resolve(REPO_ROOT, 'tests/models/landxml/imagery/nls-orthophoto-2022-m3143g-sw-road.tif');
const FIXTURES = existsSync(TERRAIN) && existsSync(ORTHO);
const SKIP = !FIXTURES && 'tests/models/landxml/imagery fixtures missing - run `pnpm fixtures`';

/** The crop, in pixels; its GSD in metres. */
const IMAGE = { width: 320, height: 280, gsd: 0.5 };

/**
 * TIN points on the surveyed road centreline (breakline 162, InfraBIM code 121)
 * and the pixel of the crop PROJ puts each on, computed independently:
 * pyproj 3.8.0 / PROJ 9.8.1, EPSG:3875 → EPSG:3067 (always_xy), then the
 * GeoTIFF's geotransform (origin 207460 E, 6791940 N, 0.5 m), corner convention.
 */
const PROJ_REFERENCE: ReadonlyArray<readonly [string, number, number]> = [
  ['17897', 45.5386, 79.6387], ['16259', 60.3418, 87.9321], ['16261', 87.6225, 104.1936],
  ['16263', 115.0107, 121.6006], ['16265', 143.4655, 140.5205], ['16267', 164.6779, 154.8047],
  ['16269', 186.9544, 170.891], ['18019', 207.674, 186.3892],
];

/**
 * The surveyed breaklines crossing the crop, by their source names:
 * 162 centreline of road (121), 173 and 175 the carriageway's edges of pavement.
 */
const CENTRELINE = '162';
const PAVEMENT_EDGES = ['173', '175'] as const;

/** Relabel ONLY the InfraModel envelope the parser refuses (#5051). */
function asLandXml12(source: string): string {
  const relabelled = source
    .replace('<?xml version="1.0" encoding="ISO-8859-1"?>', '<?xml version="1.0" encoding="UTF-8"?>')
    .replace('<LandXML xmlns="http://www.inframodel.fi/inframodel"', '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2"');
  const before = source.split('\n');
  const after = relabelled.split('\n');
  assert.equal(after.length, before.length);
  assert.deepEqual(after.slice(2), before.slice(2), 'nothing but the declaration and the root namespace changes');
  assert.notEqual(after[1], before[1], 'the root namespace was relabelled');
  return relabelled;
}

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  hookApi = null;
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
});

afterEach(async () => {
  setGlobalRendererRef({ current: null });
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

function installRenderer(): void {
  const renderer = {
    isReady: () => true,
    getScene: () => ({ removeMeshesForEntities: () => 0 }),
    addMeshes: () => ({ ok: true, value: undefined }),
    requestRender: () => {},
  };
  setGlobalRendererRef({ current: renderer as unknown as Renderer } as RefObject<Renderer | null>);
}

async function drapeRealPair() {
  const xml = asLandXml12(readFileSync(TERRAIN, 'latin1'));
  await act(async () => hookApi!.loadFile(new File([xml], 'M3_Terrain.xml', { type: 'application/xml' }), { kind: 'primary' }));
  const loaded = [...useViewerStore.getState().models.values()][0];
  assert.ok(loaded?.geometryResult?.meshes.length, 'the real terrain loaded and rendered');
  assert.equal(loaded.landXmlDocument?.coordinateSystem?.epsgCode, '3875');
  installRenderer();
  const bytes = readFileSync(ORTHO);
  const read = await readGeoRasterBundle(new GeoRasterBundle(new File([bytes], 'nls-ortho.tif'), null, []));
  assert.ok(read.ok, read.ok ? '' : read.reason);
  const [outcome] = await drapeRasterOnTerrains({
    name: read.value.name, source: 'file', placement: read.value.placement,
    image: { bytes: read.value.bytes, mime: read.value.mime },
    // happy-dom decodes no pixels; the UVs, coverage and store are all real.
    texture: async () => ({ bitmap: { width: IMAGE.width + 2, height: IMAGE.height + 2 } as ImageBitmap, imageWidth: IMAGE.width, imageHeight: IMAGE.height }),
  });
  assert.ok(outcome.result.ok, outcome.result.ok ? '' : outcome.result.reason);
  return { model: useViewerStore.getState().models.get(loaded.id)!, drape: outcome.result.value };
}

/** Per TIN point id, the crop pixel its rendered vertex samples (from the GPU UVs). */
function drapedPixels(model: ReturnType<typeof useViewerStore.getState>['models'] extends Map<string, infer M> ? M : never): Map<string, [number, number]> {
  const document = model.landXmlDocument!;
  const snapper = new SurfaceSnapper(document.surfaces[0], document.units!);
  const shift = model.geometryResult!.coordinateInfo.originShift;
  const pixels = new Map<string, [number, number]>();
  for (const mesh of model.geometryResult!.meshes as MeshData[]) {
    if (!mesh.uvs) continue;
    const recovered = snapper.sourcePlanPositions({ positions: mesh.positions, origin: mesh.origin, originShift: shift });
    assert.ok(recovered.ok);
    recovered.pointIds.forEach((id, vertex) => {
      // The bordered texture is (W + 2) × (H + 2) with the image at (1, 1).
      pixels.set(id, [mesh.uvs![vertex * 2] * (IMAGE.width + 2) - 1, mesh.uvs![vertex * 2 + 1] * (IMAGE.height + 2) - 1]);
    });
  }
  return pixels;
}

async function greyImage(): Promise<Float64Array> {
  const bytes = readFileSync(ORTHO);
  const image = await (await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).getImage(0);
  const rgb = await image.readRasters({ interleave: true }) as unknown as Uint8Array;
  const grey = new Float64Array(IMAGE.width * IMAGE.height);
  for (let i = 0; i < grey.length; i += 1) grey[i] = (rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3;
  return grey;
}

/** Bilinear grey value at plan (easting, northing), through the drape's own projection. */
function sampler(grey: Float64Array, projection: DrapeProjection) {
  return (east: number, north: number): number => {
    const [u, v] = drapeUv(projection, east, north);
    const x = u * IMAGE.width - 0.5;
    const y = (1 - v) * IMAGE.height - 0.5;
    const x0 = Math.floor(x); const y0 = Math.floor(y);
    const at = (cx: number, cy: number) => grey[Math.min(IMAGE.height - 1, Math.max(0, cy)) * IMAGE.width + Math.min(IMAGE.width - 1, Math.max(0, cx))];
    const fx = x - x0; const fy = y - y0;
    return at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
  };
}

/** Where the ray `p + s·n` crosses a polyline (plan, easting/northing), as `s`. */
function crossing(p: [number, number], n: [number, number], line: ReadonlyArray<[number, number]>): number | null {
  let best: number | null = null;
  for (let i = 0; i + 1 < line.length; i += 1) {
    const [ax, ay] = line[i]; const dx = line[i + 1][0] - ax; const dy = line[i + 1][1] - ay;
    const det = n[0] * -dy - n[1] * -dx;
    if (Math.abs(det) < 1e-12) continue;
    const s = ((ax - p[0]) * -dy - (ay - p[1]) * -dx) / det;
    const r = (n[0] * (ay - p[1]) - n[1] * (ax - p[0])) / det;
    if (r >= 0 && r <= 1 && (best === null || Math.abs(s) < Math.abs(best))) best = s;
  }
  return best;
}

const plan = (line: LandXmlPolyline): Array<[number, number]> => line.points.map(([northing, easting]) => [easting, northing]);
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

describe('#5942 real pair: 3D-Win terrain under an NLS orthophoto', () => {
  it('lands every sampled TIN vertex on the pixel PROJ puts it on', { skip: SKIP }, async () => {
    const { model, drape } = await drapeRealPair();
    assert.equal(drape.imageCrs, 'EPSG:3067');
    assert.equal(drape.projection.crs, 'EPSG:3875');
    assert.equal(drape.reprojected, true);
    assert.ok(drape.projection.deviationPx < 0.01, `planar departure ${drape.projection.deviationPx} px`);
    assert.ok(drape.coveredVertices > 0 && drape.coveredVertices < drape.totalVertices, 'a crop covers part of the terrain');
    const pixels = drapedPixels(model);
    for (const [id, col, row] of PROJ_REFERENCE) {
      const pixel = pixels.get(id);
      assert.ok(pixel, `TIN point ${id} is rendered`);
      const offset = Math.hypot(pixel[0] - col, pixel[1] - row);
      assert.ok(offset < 0.01, `TIN point ${id} drapes pixel (${pixel.join(', ')}), PROJ says (${col}, ${row}): ${offset} px apart`);
    }
  });

  it('coincides with the surveyed carriageway within the image\'s ground sample distance', { skip: SKIP }, async () => {
    const { model, drape } = await drapeRealPair();
    const breaklines = model.landXmlDocument!.surfaces[0].breaklines;
    const named = (name: string) => plan(breaklines.find((line) => line.name === name)!);
    const centre = named(CENTRELINE);
    const edges = PAVEMENT_EDGES.map(named);
    const sample = sampler(await greyImage(), drape.projection);
    const [gsd] = groundSampleDistance(drape.projection);
    const shifts: number[] = [];
    for (let i = 0; i + 1 < centre.length; i += 1) {
      const [ax, ay] = centre[i]; const [bx, by] = centre[i + 1];
      const length = Math.hypot(bx - ax, by - ay);
      const u: [number, number] = [(bx - ax) / length, (by - ay) / length];
      const n: [number, number] = [-u[1], u[0]];
      for (let t = 0.5; t < length; t += 1) {
        const p: [number, number] = [ax + u[0] * t, ay + u[1] * t];
        const surveyed = edges.map((edge) => crossing(p, n, edge));
        if (surveyed.some((s) => s === null)) continue;
        // Across-road profile at 0.05 m steps, averaged 1.5 m along the road.
        const offsets: number[] = []; const profile: number[] = [];
        for (let s = -15; s <= 15; s += 0.05) {
          let sum = 0;
          for (let a = -1.5; a <= 1.5; a += 0.25) sum += sample(p[0] + n[0] * s + u[0] * a, p[1] + n[1] * s + u[1] * a);
          offsets.push(s); profile.push(sum);
        }
        // Each imaged edge: the steepest step within 2 m of the surveyed one.
        const imaged = surveyed.map((s) => {
          let best = s!; let steepest = -1;
          for (let k = 1; k + 1 < offsets.length; k += 1) {
            if (Math.abs(offsets[k] - s!) > 2) continue;
            const slope = Math.abs(profile[k + 1] - profile[k - 1]);
            if (slope > steepest) { steepest = slope; best = offsets[k]; }
          }
          return best;
        });
        // Translation, independent of how wide the imaged asphalt reads.
        shifts.push((imaged[0] + imaged[1] - surveyed[0]! - surveyed[1]!) / 2);
      }
    }
    assert.ok(shifts.length > 50, `measured at ${shifts.length} stations`);
    const shift = median(shifts);
    assert.ok(Math.abs(shift) < gsd, `the imaged carriageway is ${shift.toFixed(3)} m across from the surveyed one; GSD ${gsd} m`);
  });
});
