/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Plan a terrain drape: per rendered TIN mesh, the texture UV of every vertex
 * and whether it lies on the image (#5942, mapping spec §15.3–§15.4).
 *
 * Pure: no renderer, no store, no image decode — so the projection a user sees
 * is testable end to end against the real LandXML mesh builder.
 */

import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import { drapeUv, uvCovered, type DrapeProjection } from '@/lib/terrain-imagery/drape-projection.js';
import type { Parsed } from '@/lib/terrain-imagery/georaster.js';
import type { LandXmlTinDocument, LandXmlTinSurface } from './landXmlSemantics.js';
import { spatialMetadataFromLandXml } from './sourceSpatialReference.js';
import { SurfaceSnapper } from './terrainImageryVertices.js';

/** The slice of a federated model the planner reads. */
export interface TerrainDrapeSource {
  document: LandXmlTinDocument;
  meshes: readonly MeshData[];
  coordinateInfo: CoordinateInfo;
  /** Present when federation re-baked the model; index-aligned with `meshes`. */
  preAlignment?: {
    positions: readonly Float32Array[];
    origins: readonly ([number, number, number] | undefined)[];
    coordinateInfo: CoordinateInfo;
  };
}

export interface TerrainDrapeMesh {
  /** Index into the model's `geometryResult.meshes`. */
  index: number;
  /** Per vertex `(u, v)`, texture origin bottom-left (§15.3). */
  uvs: Float64Array;
}

export interface TerrainDrapePlan {
  terrainCrs: string;
  meshes: TerrainDrapeMesh[];
  /** Distinct TIN vertices drawn, and how many of them the image covers. */
  totalVertices: number;
  coveredVertices: number;
}

/**
 * The terrain's horizontal CRS, or the refusal (§15.2 item 1). Only an
 * explicit EPSG declaration counts — the same adapter federation trusts.
 */
export function terrainCrsOf(document: Pick<LandXmlTinDocument, 'coordinateSystem'>): Parsed<string> {
  const id = spatialMetadataFromLandXml(document).horizontalId;
  if (id) return { ok: true, value: id };
  const declared = document.coordinateSystem?.horizontalDatum?.trim();
  return {
    ok: false,
    reason: declared
      ? `The terrain's coordinate system '${declared}' is not an explicit EPSG code, so there is nothing to place imagery against.`
      : 'The terrain declares no coordinate system, so there is nothing to place imagery against. A raster is never placed by its pixel bounds.',
  };
}

export function planTerrainDrape(source: TerrainDrapeSource, projection: DrapeProjection): Parsed<TerrainDrapePlan> {
  const { document } = source;
  const crs = terrainCrsOf(document);
  if (!crs.ok) return crs;
  if (crs.value !== projection.crs) {
    return { ok: false, reason: `The projection is expressed in ${projection.crs}, the terrain in ${crs.value}.` };
  }
  if (!document.units) return { ok: false, reason: 'The terrain has no resolved units, so it has no rendered surface.' };
  const surfaces = new Map<string, LandXmlTinSurface>(document.surfaces.map((surface) => [surface.sourceId, surface]));
  const provenance = new Map(document.rendering.meshProvenance.map((entry) => [entry.meshExpressId, entry]));
  const snappers = new Map<string, SurfaceSnapper>();
  const frameShift = (source.preAlignment?.coordinateInfo ?? source.coordinateInfo).originShift;
  const seen = new Set<string>();
  let covered = 0;
  const meshes: TerrainDrapeMesh[] = [];
  for (let index = 0; index < source.meshes.length; index += 1) {
    const mesh = source.meshes[index];
    const entry = provenance.get(mesh.expressId);
    // Pipes carry a surface-less provenance row; only TIN meshes are draped.
    if (!entry || entry.pipeSourceId || !entry.surfaceSourceId) continue;
    const surface = surfaces.get(entry.surfaceSourceId);
    if (!surface) continue;
    let snapper = snappers.get(surface.sourceId);
    if (!snapper) { snapper = new SurfaceSnapper(surface, document.units); snappers.set(surface.sourceId, snapper); }
    const recovered = snapper.sourcePlanPositions({
      positions: source.preAlignment?.positions[index] ?? mesh.positions,
      origin: source.preAlignment ? source.preAlignment.origins[index] : mesh.origin,
      originShift: frameShift,
    });
    if (!recovered.ok) return recovered;
    const uvs = new Float64Array(recovered.plan.length);
    for (let vertex = 0; vertex < recovered.pointIds.length; vertex += 1) {
      const [u, v] = drapeUv(projection, recovered.plan[vertex * 2], recovered.plan[vertex * 2 + 1]);
      uvs[vertex * 2] = u;
      uvs[vertex * 2 + 1] = v;
      const key = `${surface.sourceId}\u0000${recovered.pointIds[vertex]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (uvCovered(u, v)) covered += 1;
    }
    meshes.push({ index, uvs });
  }
  if (meshes.length === 0) return { ok: false, reason: 'The model has no rendered TIN surface to drape.' };
  if (covered === 0) {
    return { ok: false, reason: 'The image covers no vertex of this terrain: it lies elsewhere in the same CRS.' };
  }
  return { ok: true, value: { terrainCrs: crs.value, meshes, totalVertices: seen.size, coveredVertices: covered } };
}
