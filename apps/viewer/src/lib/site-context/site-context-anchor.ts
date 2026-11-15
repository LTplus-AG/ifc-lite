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
import { extractModelSpatialPlacement, type ModelSpatialPlacement } from '@/hooks/ingest/federationAlign';
import { siteContextHeightRefusal } from '@/hooks/ingest/ifcGeorefAssumptions';

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
  }
  | { ok: false; reason: 'not-georeferenced' | 'unknown-crs' | 'outside-switzerland' | 'height-datum'; detail?: string };

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
  const declaredOther = siteContextHeightRefusal(own.spatialReference);
  if (declaredOther) return { ok: false, reason: 'height-datum', detail: declaredOther };
  const projected = projectedCentre(model, frame);
  const centre = projected ? await toLv95(crs, projected[0], projected[1]) : null;
  if (!centre) return { ok: false, reason: 'unknown-crs', detail: crs };
  if (!insideSwitzerland(centre)) return { ok: false, reason: 'outside-switzerland' };
  return {
    ok: true,
    centre,
    ...(own.spatialReference.confidence === 'assumed' && own.spatialReference.horizontal ? { crsAssumedFromName: own.spatialReference.horizontal.id } : {}),
    heightAssumed: !verticalDeclared(own.spatialReference),
  };
}
