/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where "Load site context" fetches around: the centre of a georeferenced
 * model in EPSG:2056, and whether the model can host Swiss site context at
 * all. Refusals carry a reason the UI turns into an action (open the
 * georeference editor) or an explanation; nothing is guessed, and there is no
 * manual placement mode.
 */

import { localViewerToProjected, type ModelSpatialReference } from '@ifc-lite/geometry';
import proj4 from 'proj4';
import { useViewerStore, type FederatedModel } from '@/store';
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import { resolveProjectionId } from '@/lib/geo/reproject';
import { mapUnitAssumedMetres } from '@/lib/geo/ifc-spatial-reference';
import { extractModelSpatialPlacement, findReferenceSpatialModel, type ModelSpatialPlacement } from '@/hooks/ingest/federationAlign';
import { canonicalRendererPlacement } from '@/hooks/ingest/federationCanonicalReference';
import { siteContextHeightRefusal } from '@/hooks/ingest/ifcGeorefAssumptions';
import { modelEgid, modelFootprint } from './site-context-subject';

/** Switzerland and Liechtenstein in LV95, generously: swisstopo's terrain and cadastre cover this. */
const SWISS_EXTENT = { minE: 2_480_000, maxE: 2_840_000, minN: 1_070_000, maxN: 1_300_000 };

export type SiteContextAnchor =
  | {
    ok: true;
    /** EPSG:2056, easting first. */
    centre: { x: number; y: number };
    /** The EPSG id the model's CRS was taken to be from a well-known name, when not stated as a literal code. */
    crsAssumedFromName?: string;
    /** The model states no vertical datum; its heights will be taken as LN02. */
    heightAssumed: boolean;
    /** The model's MapUnit reads as METRE, which an unreadable MapUnit also does: metres are assumed. */
    mapUnitAssumed: boolean;
    /** The model's own building for the buildings layer: its EGID, else its footprint in EPSG:2056. */
    subject?: { egid?: string; footprint?: Array<Array<{ x: number; y: number }>> };
  }
  | { ok: false; reason: 'not-georeferenced' | 'unknown-crs' | 'outside-switzerland' | 'height-datum' | 'height-unknown'; detail?: string };

/** The placement a model's geometry is in: the reference it was aligned to, else its own. */
export function modelPlacement(model: FederatedModel, mutations = useViewerStore.getState().georefMutations.get(model.id)): {
  own: ModelSpatialPlacement | null;
  frame: ModelSpatialPlacement | null;
} {
  const own = model.spatialReference && model.geometryResult
    ? { spatialReference: model.spatialReference, coordinateInfo: model.geometryResult.coordinateInfo }
    : model.ifcDataStore && model.geometryResult
      ? extractModelSpatialPlacement(model.ifcDataStore, model.geometryResult.coordinateInfo, mutations)
      : null;
  return { own, frame: model.alignmentReference ?? own };
}

/** The model's bounding-box centre in its frame's projected CRS. */
function projectedCentre(model: FederatedModel, frame: ModelSpatialPlacement): readonly [number, number, number] | null {
  const bounds = model.geometryResult?.coordinateInfo?.shiftedBounds;
  const point: [number, number, number] = bounds && Number.isFinite(bounds.min.x) && Number.isFinite(bounds.max.x)
    ? [(bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2, (bounds.min.z + bounds.max.z) / 2]
    : [0, 0, 0];
  return localViewerToProjected(frame.spatialReference, point, totalYupOffset(frame.coordinateInfo));
}

async function toLv95(crs: string, e: number, n: number): Promise<{ x: number; y: number } | null> {
  if (crs === 'EPSG:2056') return { x: e, y: n };
  const [from, to] = await Promise.all([resolveProjectionId(crs), resolveProjectionId('EPSG:2056')]);
  if (!from || !to) return null;
  try {
    const [x, y] = proj4(from, to, [e, n]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch (error) {
    console.warn(`[site-context] ${crs} → EPSG:2056 failed:`, error);
    return null;
  }
}

export function insideSwitzerland(centre: { x: number; y: number }): boolean {
  return centre.x >= SWISS_EXTENT.minE && centre.x <= SWISS_EXTENT.maxE && centre.y >= SWISS_EXTENT.minN && centre.y <= SWISS_EXTENT.maxN;
}

function verticalDeclared(reference: ModelSpatialReference): boolean {
  return reference.vertical !== undefined || (typeof reference.sourceMetadata?.verticalDatum === 'string' && reference.sourceMetadata.verticalDatum.trim() !== '');
}

/**
 * The reference a loaded site context is placed against: the federation's
 * reference model, else `fallback`. The section's height statements and the
 * load's refusal both read it, so they always describe the same model.
 */
export function siteContextPlacementReference(fallback?: ModelSpatialReference): ModelSpatialReference | null {
  return findReferenceSpatialModel()?.placement.spatialReference ?? fallback ?? null;
}

/**
 * True when `modelId` still resolves to the centre `captured` was taken from. Checked again right
 * before a load is dispatched, since the georeference can change between the click and the
 * dispatch (#10481 review).
 */
export async function anchorStillCurrent(modelId: string, captured: { centre: { x: number; y: number } }): Promise<boolean> {
  const fresh = await resolveSiteContextAnchor(modelId);
  return fresh.ok && fresh.centre.x === captured.centre.x && fresh.centre.y === captured.centre.y;
}

/** Resolve the model `modelId` as a site-context anchor. */
export async function resolveSiteContextAnchor(modelId: string): Promise<SiteContextAnchor> {
  const model = useViewerStore.getState().models.get(modelId);
  if (!model) return { ok: false, reason: 'not-georeferenced' };
  const { own, frame } = modelPlacement(model);
  if (!own || !frame) return { ok: false, reason: 'not-georeferenced' };
  const crs = frame.spatialReference.horizontal?.id;
  if (!crs) {
    const name = frame.spatialReference.sourceMetadata?.projectedCrsName;
    return { ok: false, reason: 'unknown-crs', detail: typeof name === 'string' ? name : undefined };
  }
  // Heights are judged on what the load places against, not on the selected model alone (#10481 review).
  const heights = siteContextPlacementReference(own.spatialReference) ?? own.spatialReference;
  const declaredOther = siteContextHeightRefusal(heights);
  if (declaredOther) return { ok: false, reason: 'height-datum', detail: declaredOther };
  // LN02 is assumed for an IFC model that states no datum; for any other format nothing is assumed.
  if (!verticalDeclared(heights) && heights.sourceMetadata?.format !== 'ifc') return { ok: false, reason: 'height-unknown' };
  // Renderer-space bounds and meshes are east/up/south metres: project them through the canonical
  // renderer frame, as federation does, not a source's native axes or units (#10481 review). The raw
  // `own` reference still answers the CRS-name and map-unit questions below.
  const rendered = canonicalRendererPlacement(frame);
  const projected = projectedCentre(model, rendered);
  const centre = projected ? await toLv95(crs, projected[0], projected[1]) : null;
  if (!centre) return { ok: false, reason: 'unknown-crs', detail: crs };
  if (!insideSwitzerland(centre)) return { ok: false, reason: 'outside-switzerland' };
  const egid = modelEgid(model.ifcDataStore);
  let footprint: Array<{ x: number; y: number }> | null = null;
  if (!egid) {
    const ring = modelFootprint(model, rendered);
    const lv95 = ring ? await Promise.all(ring.map(([e, n]) => toLv95(crs, e, n))) : [];
    footprint = lv95.length === 4 && lv95.every((p) => p !== null) ? lv95 as Array<{ x: number; y: number }> : null;
  }
  return {
    ...(egid ? { subject: { egid } } : footprint ? { subject: { footprint: [footprint] } } : {}),
    ok: true,
    centre,
    ...(own.spatialReference.confidence === 'assumed' && own.spatialReference.horizontal ? { crsAssumedFromName: own.spatialReference.horizontal.id } : {}),
    heightAssumed: !verticalDeclared(heights),
    mapUnitAssumed: mapUnitAssumedMetres(own.spatialReference),
  };
}
