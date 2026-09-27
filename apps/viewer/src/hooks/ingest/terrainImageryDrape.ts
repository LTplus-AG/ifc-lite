/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drape a georeferenced raster on every loaded LandXML terrain (#5942,
 * mapping spec §15). Reached from `useIfcLoader.loadFile` — the one load path
 * — for a raster bundle, and from the tile-source panel for a tile mosaic.
 *
 * A raster creates no model. Per terrain it is placed through the same CRS
 * contract federation uses (`spatialMetadataFromLandXml`,
 * `resolveProjectionOperation`), projected per vertex (`terrainImageryPlan`),
 * and rendered through the existing textured-mesh path: the drape REPLACES the
 * terrain's meshes with copies carrying `uvs` + `textureRef` + `textureBitmap`,
 * on the GPU and in the store, so a later scene rebuild uploads them textured
 * again rather than reverting to flat.
 */

import proj4 from 'proj4';
import type { MeshData } from '@ifc-lite/geometry';
import { toast } from '@/components/ui/toast';
import { useViewerStore, type FederatedModel } from '@/store';
import { resolveProjectionOperation } from '@/lib/geo/reproject.js';
import { modelIndices } from '@/lib/model-placement/model-indices.js';
import { drapeProjection, groundSampleDistance, type PlanTransform } from '@/lib/terrain-imagery/drape-projection.js';
import { coveredFraction, type TerrainImageryDrape } from '@/lib/terrain-imagery/drape-state.js';
import type { GeoRasterPlacement, Parsed } from '@/lib/terrain-imagery/georaster.js';
import { borderedGpuUvs, decodeDrapeTexture, type DrapeTexture } from '@/lib/terrain-imagery/raster-texture.js';
import type { GeoRasterBundle } from '@/lib/terrain-imagery/raster-bundle.js';
import { readGeoRasterBundle, type GeoRasterMime } from '@/lib/terrain-imagery/read-raster.js';
import { computeFullSourceHash } from '@/utils/sourceContentHash.js';
import { getGlobalRenderer } from '../useBCF.js';
import { isLandXmlSchema } from './landXmlSemantics.js';
import { planTerrainDrape, terrainCrsOf, type TerrainDrapePlan } from './terrainImageryPlan.js';

/** A raster ready to drape, from a file or a tile mosaic. */
export interface DrapeRaster {
  name: string;
  source: TerrainImageryDrape['source'];
  placement: GeoRasterPlacement;
  /** The file as supplied; absent for tiles, which are never exported. */
  image?: { bytes: Uint8Array; mime: GeoRasterMime };
  /** Produce the bordered GPU texture (§15.4). */
  texture: (border: readonly [number, number, number]) => Promise<DrapeTexture>;
}

export interface DrapeOutcome {
  modelId: string;
  modelName: string;
  result: Parsed<TerrainImageryDrape>;
}

// Renderer cache keys for drape textures. Negative, like the appearance
// preview's, and in their own range so the two never share a GPU texture.
let nextTextureId = -2_000_000_000;

/** The terrain colour drawn outside the image (§15.4): the undraped mesh colour. */
function flatColour(model: FederatedModel, plan: TerrainDrapePlan): [number, number, number] {
  const previous = model.terrainImagery;
  if (previous) return previous.flatColour;
  const [r, g, b] = model.geometryResult!.meshes[plan.meshes[0].index].color;
  return [r, g, b];
}

async function toTerrainCrs(imageCrs: string, terrainCrs: string): Promise<Parsed<PlanTransform | undefined>> {
  if (imageCrs.toUpperCase() === terrainCrs.toUpperCase()) return { ok: true, value: undefined };
  const [from, to] = await Promise.all([resolveProjectionOperation(imageCrs), resolveProjectionOperation(terrainCrs)]);
  const refuse = (id: string, reason: string): Parsed<never> => ({
    ok: false,
    reason: `The image is in ${imageCrs} and the terrain in ${terrainCrs}, and ${id} cannot be resolved exactly `
      + `(${reason.replace(/-/g, ' ')}), so the image is not reprojected on a guess.`,
  });
  if (from.kind === 'refused') return refuse(imageCrs, from.reason);
  if (to.kind === 'refused') return refuse(terrainCrs, to.reason);
  const converter = proj4(from.definition, to.definition);
  return { ok: true, value: (x, y) => converter.forward([x, y]) as [number, number] };
}

/** Loaded LandXML models with rendered geometry, optionally only `modelIds`. */
export function terrainModels(modelIds?: readonly string[]): FederatedModel[] {
  return [...useViewerStore.getState().models.values()].filter((model) => (
    model.sourceSchema !== undefined && isLandXmlSchema(model.sourceSchema) && model.landXmlDocument && model.geometryResult
    && (!modelIds || modelIds.includes(model.id))
  ));
}

/** Plan one terrain; nothing is touched until every step has succeeded. */
async function planModel(
  model: FederatedModel, raster: DrapeRaster,
): Promise<Parsed<{ plan: TerrainDrapePlan; drape: Omit<TerrainImageryDrape, 'textureId' | 'displayedGsd' | 'flatColour'> }>> {
  const document = model.landXmlDocument!;
  const terrainCrs = terrainCrsOf(document);
  if (!terrainCrs.ok) return terrainCrs;
  const imageCrs = raster.placement.crs;
  if (!imageCrs) {
    return {
      ok: false,
      reason: `${raster.name} declares no CRS with an EPSG code (read from: ${raster.placement.crsSource}). `
        + 'Supply a .prj or .aux.xml that names one; the image is never assumed to share the terrain\'s CRS.',
    };
  }
  const transform = await toTerrainCrs(imageCrs, terrainCrs.value);
  if (!transform.ok) return transform;
  const projection = drapeProjection(raster.placement, terrainCrs.value, transform.value);
  if (!projection.ok) return projection;
  const geometry = model.geometryResult!;
  if (geometry.meshes.some((mesh) => mesh.positions.length === 0 && mesh.indices.length > 0)) {
    return { ok: false, reason: 'The terrain\'s geometry has been released from memory; reload it to drape imagery.' };
  }
  const plan = planTerrainDrape({
    document, meshes: geometry.meshes, coordinateInfo: geometry.coordinateInfo,
    ...(model.preAlignment ? { preAlignment: model.preAlignment } : {}),
  }, projection.value);
  if (!plan.ok) return plan;
  return {
    ok: true,
    value: {
      plan: plan.value,
      drape: {
        sourceName: raster.name, source: raster.source, placement: raster.placement.placement,
        imageCrs, imageCrsSource: raster.placement.crsSource, projection: projection.value,
        reprojected: transform.value !== undefined,
        totalVertices: plan.value.totalVertices, coveredVertices: plan.value.coveredVertices,
      },
    },
  };
}

/** Swap the terrain's meshes for textured copies, on the GPU and in the store. */
function applyDrape(model: FederatedModel, plan: TerrainDrapePlan, texture: DrapeTexture, drape: TerrainImageryDrape): void {
  const renderer = getGlobalRenderer();
  if (!renderer || !renderer.isReady()) throw new Error('The viewport is not ready to show imagery yet.');
  const modelIndex = modelIndices(useViewerStore.getState().models).get(model.id) ?? 0;
  const geometry = model.geometryResult!;
  const meshes = [...geometry.meshes];
  const gpu: MeshData[] = [];
  for (const { index, uvs } of plan.meshes) {
    const mesh = meshes[index];
    const draped: MeshData = {
      ...mesh,
      uvs: borderedGpuUvs(uvs, texture.imageWidth, texture.imageHeight),
      textureRef: { textureId: drape.textureId, url: drape.sourceName, repeatS: false, repeatT: false },
      textureBitmap: texture.bitmap,
      // `texture(uv) × baseColor`: white passes the image through untinted.
      color: [1, 1, 1, mesh.color[3]],
    };
    meshes[index] = draped;
    gpu.push({ ...draped, modelIndex });
  }
  renderer.getScene().removeMeshesForEntities(gpu.map((mesh) => mesh.expressId));
  const uploaded = renderer.addMeshes(gpu, false);
  if (!uploaded.ok) throw new Error(`The imagery could not be uploaded to the GPU (${uploaded.reason}).`);
  const next = { ...geometry, meshes };
  const state = useViewerStore.getState();
  if (state.geometryResult === geometry) state.setGeometryResult(next);
  state.updateModel(model.id, { geometryResult: next, terrainImagery: drape });
  renderer.requestRender();
}

/** Drape one raster on every loaded LandXML terrain; one outcome per terrain. */
export async function drapeRasterOnTerrains(raster: DrapeRaster, modelIds?: readonly string[]): Promise<DrapeOutcome[]> {
  const models = terrainModels(modelIds);
  if (models.length === 0) {
    throw new Error(`${raster.name} is imagery, not a model: load a LandXML terrain first, then drape its imagery on it.`);
  }
  const planned = await Promise.all(models.map(async (model) => ({ model, planned: await planModel(model, raster) })));
  const accepted = planned.filter((entry) => entry.planned.ok);
  const outcomes: DrapeOutcome[] = planned
    .filter((entry) => !entry.planned.ok)
    .map(({ model, planned: result }) => ({ modelId: model.id, modelName: model.name, result: result as { ok: false; reason: string } }));
  if (accepted.length === 0) return outcomes;
  // Before the decode: an image the viewport cannot show is not worth decoding.
  if (!getGlobalRenderer()?.isReady()) throw new Error('The viewport is not ready to show imagery yet.');
  const first = accepted[0].planned as { ok: true; value: { plan: TerrainDrapePlan } };
  const colour = flatColour(accepted[0].model, first.value.plan);
  const texture = await raster.texture(colour);
  const sha256 = raster.image ? await computeFullSourceHash(raster.image.bytes) : null;
  const textureId = nextTextureId++;
  for (const { model, planned: result } of accepted) {
    if (!result.ok) continue;
    const [gsdU, gsdV] = groundSampleDistance(result.value.drape.projection);
    const drape: TerrainImageryDrape = {
      ...result.value.drape,
      textureId,
      flatColour: colour,
      displayedGsd: Math.max(
        (gsdU * raster.placement.width) / texture.imageWidth, (gsdV * raster.placement.height) / texture.imageHeight,
      ),
      ...(raster.image && sha256 ? { image: { ...raster.image, sha256 } } : {}),
    };
    applyDrape(model, result.value.plan, texture, drape);
    outcomes.push({ modelId: model.id, modelName: model.name, result: { ok: true, value: drape } });
  }
  return outcomes;
}

/** Report outcomes the way every load reports: a toast per result. */
export function reportDrapeOutcomes(outcomes: readonly DrapeOutcome[]): void {
  for (const { modelName, result } of outcomes) {
    if (result.ok) {
      const percent = (coveredFraction(result.value) * 100).toFixed(1);
      toast.success(`${result.value.sourceName} draped on ${modelName}: ${percent} % of its vertices covered.`);
    } else {
      toast.error(`Imagery not draped on ${modelName}: ${result.reason}`);
    }
  }
}

/** `loadFile`'s branch for a raster bundle: read, place, drape, report. */
export async function drapeGeoRasterBundle(bundle: GeoRasterBundle): Promise<void> {
  try {
    const read = await readGeoRasterBundle(bundle);
    if (!read.ok) { toast.error(`Imagery not draped: ${read.reason}`); return; }
    const loaded = read.value;
    reportDrapeOutcomes(await drapeRasterOnTerrains({
      name: loaded.name, source: 'file', placement: loaded.placement,
      image: { bytes: loaded.bytes, mime: loaded.mime },
      texture: (border) => decodeDrapeTexture(loaded, border),
    }));
  } catch (error) {
    console.error('[terrain-imagery] drape failed:', error);
    toast.error(`Imagery not draped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
