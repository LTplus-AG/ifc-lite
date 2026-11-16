/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SWISSIMAGE, and the federal surface-runoff hazard map, draped on a
 * site-context terrain model.
 *
 * The sibling of `terrainImageryDrape.ts` for site context, not a bend of it:
 * that planner projects LandXML vertices through the document's CRS. Here the
 * core already emitted UVs over the terrain's plan box (u east, v south), so
 * the drape is WMS GetMap requests for plan boxes in EPSG:2056, with the
 * same texture path. A drape makes up to two requests: a fine one (10 cm) for
 * the chunks around the model, for eye-level views, and a coarse one (25 cm or
 * coarser, within the texture size limit) for the rest of the site, since one
 * 10 cm image of a large site would exceed the texture limit. Both share the
 * abort signal, the allowlist and the cache, and carry the same attribution.
 * The texture path is a one-texel border in the flat terrain colour
 * (`borderedTexture`), clamp-to-edge sampling, and the terrain meshes replaced
 * by textured copies on the GPU and in the store, as `applyDrape` does.
 *
 * WMS returns an image covering the requested box exactly at the requested
 * pixel size, so the core's UVs map onto it unchanged. Each request goes
 * through the swisstopo host allowlist and the response cache.
 *
 * The hazard layer (BAFU's overland flow map) is a second WMS image per level,
 * requested for the same box at the same pixel size and drawn over the aerial
 * image (or over the flat terrain colour when no imagery is asked for) in the
 * publisher's own legend colours, unaltered. Either layer can be switched on
 * or off by draping again: each draped mesh remembers the core mesh it was
 * made from, so a second drape starts from the core's UVs, and with neither
 * layer the core meshes come back untextured.
 */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { createSwissGeodata, type MapLayerDescriptor } from '@ifc-lite/geodata-ch';
import { useViewerStore } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { borderedGpuUvs, borderedTexture, type DrapeTexture } from '@/lib/terrain-imagery/raster-texture';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { createSiteContextResponseCache } from './response-cache';
import { swisstopoFetch } from './swisstopo-fetch';

/** Ground sample distance of the drape over the whole site; 25 cm reads well from the air. */
const COARSE_GSD = 0.25;
/** Near the model: SWISSIMAGE's own 10 cm, for eye-level views. */
const FINE_GSD = 0.1;
/** Terrain chunks within this distance of the site centre (the model) get the fine drape, in metres. */
export const FINE_DRAPE_HALF_SIZE = 100;
/** Longest side of the requested image, in pixels. */
const MAX_PIXELS = 4096;
/**
 * How long one imagery request may take before it is given up, in ms. Abort alone left a stalled
 * WMS request (and so the run that awaits the drape) pending until the user cancelled (#10481 review).
 */
export const IMAGERY_REQUEST_TIMEOUT_MS = 60_000;

/** The caller's signal, also aborted after `ms`. */
export function withRequestTimeout(signal: AbortSignal | undefined, ms = IMAGERY_REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * All images, or a rejection with every image that did arrive closed: `Promise.all` alone left the
 * successful bitmap of a pair open when the other request failed (#10481 review).
 */
export async function settleImages<T extends { close(): void }>(requests: ReadonlyArray<Promise<T>>): Promise<T[]> {
  const results = await Promise.allSettled(requests);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (!failed) return results.map((r) => (r as PromiseFulfilledResult<T>).value);
  for (const r of results) if (r.status === 'fulfilled') r.value.close();
  throw failed.reason;
}

// Renderer cache keys for drape textures, in their own negative range.
let nextTextureId = -2_100_000_000;

export interface SiteContextImageryRequest {
  url: string;
  width: number;
  height: number;
  groundSampleDistance: number;
  /** The image format asked for. */
  mime: string;
}

/** A layer descriptor from the geodata client's layer table (no network). */
function geodataLayer(id: string): MapLayerDescriptor {
  const layer = createSwissGeodata().mapLayers().find((entry) => entry.id === id);
  if (!layer) throw new Error(`The ${id} layer descriptor is missing from @ifc-lite/geodata-ch.`);
  return layer;
}

/** The SWISSIMAGE descriptor. */
export function swissimageLayer(): MapLayerDescriptor {
  return geodataLayer('ch.swisstopo.swissimage');
}

/** BAFU's overland flow map (Gefährdungskarte Oberflächenabfluss), attributed © FOEN. */
export const RUNOFF_HAZARD_LAYER_ID = 'ch.bafu.gefaehrdungskarte-oberflaechenabfluss';
export function runoffHazardLayer(): MapLayerDescriptor {
  return geodataLayer(RUNOFF_HAZARD_LAYER_ID);
}

/**
 * A WMS 1.3.0 GetMap for `box` (EPSG:2056, easting first: LV95's axis order is
 * E, N), in the layer's own format; a PNG layer is asked for with transparency,
 * so where nothing is mapped the layer below shows through.
 */
export function wmsMapRequest(
  layer: MapLayerDescriptor, box: readonly [number, number, number, number], minGsd = COARSE_GSD,
): SiteContextImageryRequest | null {
  const wms = layer.services.find((service) => service.type === 'WMS');
  if (!wms || wms.type !== 'WMS') return null;
  const [minE, minN, maxE, maxN] = box;
  const extent = Math.max(maxE - minE, maxN - minN);
  if (!(extent > 0)) return null;
  const gsd = Math.max(minGsd, extent / MAX_PIXELS);
  const width = Math.max(1, Math.round((maxE - minE) / gsd));
  const height = Math.max(1, Math.round((maxN - minN) / gsd));
  const url = new URL(wms.url);
  const params: Record<string, string> = {
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: wms.layers, STYLES: '', CRS: 'EPSG:2056',
    BBOX: [minE, minN, maxE, maxN].join(','), WIDTH: String(width), HEIGHT: String(height), FORMAT: wms.format,
    ...(wms.format === 'image/png' ? { TRANSPARENT: 'TRUE' } : {}),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { url: url.toString(), width, height, groundSampleDistance: gsd, mime: wms.format };
}

/** Core UVs (top-left origin) → the bordered GPU texture's UVs. */
export function siteContextGpuUvs(uvs: Float32Array, width: number, height: number): Float32Array {
  const flipped = new Float64Array(uvs.length);
  for (let i = 0; i < uvs.length; i += 2) {
    flipped[i] = uvs[i];
    flipped[i + 1] = 1 - uvs[i + 1];
  }
  return borderedGpuUvs(flipped, width, height);
}

async function fetchImage(request: SiteContextImageryRequest, source: string, signal?: AbortSignal): Promise<ImageBitmap> {
  const cache = createSiteContextResponseCache();
  const cached = await cache.get(request.url);
  let body: ArrayBuffer;
  if (cached) body = cached.body;
  else {
    const response = await swisstopoFetch().fetch(request.url, { signal: withRequestTimeout(signal) });
    if (!response.ok) throw new Error(`${source} answered ${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    body = await response.arrayBuffer();
    if (!type.startsWith('image/')) throw new Error(`${source} answered ${type || 'no content type'}, not an image`);
    await cache.set(request.url, { status: response.status, headers: { 'content-type': type }, body });
  }
  return createImageBitmap(new Blob([body], { type: request.mime }));
}

type PlanBox = readonly [number, number, number, number];

/** A chunk's plan box from its core UVs (u east, v south over the terrain box `site`). */
export function meshPlanBox(uvs: Float32Array, site: PlanBox): PlanBox {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < uvs.length; i += 2) {
    u0 = Math.min(u0, uvs[i]); u1 = Math.max(u1, uvs[i]);
    v0 = Math.min(v0, uvs[i + 1]); v1 = Math.max(v1, uvs[i + 1]);
  }
  const [minE, minN, maxE, maxN] = site;
  const w = maxE - minE, h = maxN - minN;
  return [minE + u0 * w, maxN - v1 * h, minE + u1 * w, maxN - v0 * h];
}

/**
 * Which chunks get the fine drape: those whose plan box meets the square of
 * `FINE_DRAPE_HALF_SIZE` around the site centre (the site is centred on the
 * model). Returns the chunk indices and the union of their boxes, or `null`
 * when no chunk qualifies.
 */
export function planFineDrape(boxes: ReadonlyArray<PlanBox | null>, site: PlanBox, half = FINE_DRAPE_HALF_SIZE): { indices: Set<number>; box: PlanBox } | null {
  const cx = (site[0] + site[2]) / 2, cy = (site[1] + site[3]) / 2;
  const indices = new Set<number>();
  let box: [number, number, number, number] | null = null;
  boxes.forEach((b, index) => {
    if (!b || b[2] < cx - half || b[0] > cx + half || b[3] < cy - half || b[1] > cy + half) return;
    indices.add(index);
    box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : [b[0], b[1], b[2], b[3]];
  });
  return box && indices.size > 0 ? { indices, box } : null;
}

/** Core UVs over the site box → the same points' UVs over `target` (both top-left origin). */
export function remapUvs(uvs: Float32Array, site: PlanBox, target: PlanBox): Float32Array {
  const [minE, minN, maxE, maxN] = site;
  const [tMinE, tMinN, tMaxE, tMaxN] = target;
  const su = (maxE - minE) / (tMaxE - tMinE), ou = (minE - tMinE) / (tMaxE - tMinE);
  const sv = (maxN - minN) / (tMaxN - tMinN), ov = (tMaxN - maxN) / (tMaxN - tMinN);
  const out = new Float32Array(uvs.length);
  for (let i = 0; i < uvs.length; i += 2) {
    out[i] = uvs[i] * su + ou;
    out[i + 1] = uvs[i + 1] * sv + ov;
  }
  return out;
}

/** What to drape on the terrain. With neither, the terrain is shown untextured again. */
export interface TerrainDrapeLayers {
  imagery: boolean;
  hazard: boolean;
}

/** One texture: a plan box, its WMS request per layer (imagery, hazard), and the composed result. */
interface DrapeLevel {
  box: PlanBox;
  requests: Array<SiteContextImageryRequest | null>;
  width: number;
  height: number;
  groundSampleDistance: number;
  textureId: number;
  texture?: DrapeTexture;
}

const SOURCE_NAMES = ['SWISSIMAGE', 'The overland flow map'] as const;

/** The core mesh each draped copy was made from, so a later drape starts from the core's UVs. */
const coreMeshOf = new WeakMap<MeshData, MeshData>();

/**
 * The core meshes behind `meshes`. A textured mesh without a recorded core is
 * refused: its UVs are already the texture's, and draping from them again
 * would misplace the image.
 */
function coreMeshes(meshes: readonly MeshData[]): MeshData[] {
  return meshes.map((mesh) => {
    const core = coreMeshOf.get(mesh);
    if (core) return core;
    if (mesh.textureRef) throw new Error('This terrain was changed after it was draped; load the site context again to change its layers.');
    return mesh;
  });
}

/**
 * One layer as given, or the hazard map over the imagery. `borderedTexture`
 * frames the result in the flat terrain colour, which also shows through
 * wherever the hazard map alone is transparent (no runoff modelled).
 */
function composeLevel(level: DrapeLevel, flat: readonly [number, number, number], imagery: ImageBitmap | null, hazard: ImageBitmap | null): DrapeTexture {
  const { width, height } = level;
  if (!imagery || !hazard) {
    const single = imagery ?? hazard;
    if (!single) throw new Error('No map layer arrived to drape.');
    return borderedTexture(single, width, height, flat);
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot compose the drape texture (no 2D canvas).');
  context.drawImage(imagery, 0, 0, width, height);
  // The publisher's legend colours, unaltered (no opacity): the viewport legend shows the same swatches.
  context.drawImage(hazard, 0, 0, width, height);
  return borderedTexture(canvas, width, height, flat);
}

function uploadTerrain(modelId: string, geometry: GeometryResult, meshes: MeshData[], changed: MeshData[]): void {
  const renderer = getGlobalRenderer();
  if (!renderer || !renderer.isReady()) throw new Error('The viewport is not ready to show the terrain layers yet.');
  const modelIndex = modelIndices(useViewerStore.getState().models).get(modelId) ?? 0;
  const gpu = changed.map((mesh) => ({ ...mesh, modelIndex }));
  renderer.getScene().removeMeshesForEntities(gpu.map((mesh) => mesh.expressId));
  const uploaded = renderer.addMeshes(gpu, false);
  if (!uploaded.ok) throw new Error(`The terrain layers could not be uploaded to the GPU (${uploaded.reason}).`);
  const next = { ...geometry, meshes };
  const latest = useViewerStore.getState();
  if (latest.geometryResult === geometry) latest.setGeometryResult(next);
  latest.updateModel(modelId, { geometryResult: next });
  renderer.requestRender();
}

/**
 * Drape the chosen layers on the site-context terrain model `modelId`, in two
 * levels: 10 cm on the chunks around the model, 25 cm (or coarser, within the
 * texture limit) on the rest. Each level is its own texture through the
 * existing textured-mesh path; a chunk takes exactly one. Imagery and hazard
 * map of a level are requested for the same box at the same pixel size, so
 * they line up. Throws with a user-facing reason.
 */
export async function drapeSiteContextTerrain(modelId: string, layers: TerrainDrapeLayers, signal?: AbortSignal): Promise<void> {
  const state = useViewerStore.getState();
  const info = state.siteContextModels.get(modelId);
  const model = state.models.get(modelId);
  if (!info || info.kind !== 'terrain' || !info.planBox || !model?.geometryResult) {
    throw new Error('Map layers drape on a loaded site-context terrain only.');
  }
  const site = info.planBox;
  const core = coreMeshes(model.geometryResult.meshes);
  const coreCount = core.length;

  if (!layers.imagery && !layers.hazard) {
    const geometry = model.geometryResult;
    uploadTerrain(modelId, geometry, core, core.filter((mesh) => mesh.uvs));
    useViewerStore.getState().updateSiteContextModel(modelId, { imagery: undefined, hazard: undefined });
    return;
  }

  const sources = [layers.imagery ? swissimageLayer() : null, layers.hazard ? runoffHazardLayer() : null];
  const planLevel = (box: PlanBox, minGsd: number): DrapeLevel | null => {
    const requests = sources.map((layer) => (layer ? wmsMapRequest(layer, box, minGsd) : null));
    const first = requests.find((request) => request !== null);
    if (!first || requests.some((request, i) => sources[i] && !request)) return null;
    return { box, requests, width: first.width, height: first.height, groundSampleDistance: first.groundSampleDistance, textureId: nextTextureId-- };
  };
  const boxes = core.map((mesh) => (mesh.uvs ? meshPlanBox(mesh.uvs, site) : null));
  const fine = planFineDrape(boxes, site);
  const fineLevel = fine ? planLevel(fine.box, FINE_GSD) : null;
  const needsCoarse = boxes.some((b, index) => b && !(fineLevel && fine?.indices.has(index)));
  const coarseLevel = needsCoarse ? planLevel(site, COARSE_GSD) : null;
  if (needsCoarse && !coarseLevel) throw new Error('The terrain has no plan extent to request map layers for.');
  const levels = [fineLevel, coarseLevel].filter((level): level is DrapeLevel => level !== null);
  if (levels.length === 0) throw new Error('The terrain has no plan extent to request map layers for.');

  const wanted = levels.flatMap((level) => level.requests.flatMap((request, slot) => (request ? [{ level, slot, request }] : [])));
  const images = await settleImages(wanted.map((w) => fetchImage(w.request, SOURCE_NAMES[w.slot], signal)));
  const closeAll = () => { for (const image of images) image.close(); };
  const geometry = useViewerStore.getState().models.get(modelId)?.geometryResult;
  let latestCore: MeshData[];
  try {
    if (!geometry) throw new Error('The terrain was removed before its map layers arrived.');
    latestCore = coreMeshes(geometry.meshes);
    if (latestCore.length !== coreCount) throw new Error('The terrain changed while its map layers were loading.');
    const flat = latestCore.find((mesh) => mesh.uvs)?.color ?? [0.8, 0.78, 0.72, 1];
    for (const level of levels) {
      const imageOf = (slot: number) => images[wanted.findIndex((w) => w.level === level && w.slot === slot)] ?? null;
      level.texture = composeLevel(level, [flat[0], flat[1], flat[2]], imageOf(0), imageOf(1));
    }
  } finally {
    closeAll();
  }

  const label = sources.flatMap((layer) => (layer ? [layer.id] : [])).join('+');
  const meshes = [...geometry.meshes];
  const changed: MeshData[] = [];
  latestCore.forEach((mesh, index) => {
    if (!mesh.uvs) return;
    const level = fineLevel && fine?.indices.has(index) ? fineLevel : coarseLevel;
    if (!level?.texture) return;
    const uvs = level.box === site ? mesh.uvs : remapUvs(mesh.uvs, site, level.box);
    const draped: MeshData = {
      ...mesh,
      uvs: siteContextGpuUvs(uvs, level.texture.imageWidth, level.texture.imageHeight),
      textureRef: { textureId: level.textureId, url: label, repeatS: false, repeatT: false },
      textureBitmap: level.texture.bitmap,
      // `texture(uv) × baseColor`: white passes the image through untinted.
      color: [1, 1, 1, mesh.color[3]],
    };
    coreMeshOf.set(draped, mesh);
    meshes[index] = draped;
    changed.push(draped);
  });
  if (changed.length === 0) throw new Error('The terrain carries no texture coordinates to drape on.');
  uploadTerrain(modelId, geometry, meshes, changed);
  const gsd = (coarseLevel ?? levels[0]).groundSampleDistance;
  const near = fineLevel ? { nearGroundSampleDistance: fineLevel.groundSampleDistance } : {};
  useViewerStore.getState().updateSiteContextModel(modelId, {
    imagery: sources[0] ? { attribution: sources[0].attribution, groundSampleDistance: gsd, ...near } : undefined,
    hazard: sources[1] ? { attribution: sources[1].attribution, groundSampleDistance: gsd, ...near } : undefined,
  });
}
