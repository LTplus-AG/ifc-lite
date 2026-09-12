/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { modelAppearanceAssets } from '../model-assets.js';
import type { AppearanceAssetOwner } from '../assets.js';
import type { AppearanceDraftSettings, AppearanceSourceOption } from '../draft-types.js';
import type { AppearanceSnapshot } from '../snapshot.js';
import type { AppearanceFaceMask } from '../planner-types.js';
import type { createAppearancePlanner } from '../planner-worker-client.js';
import { prepareAppearanceRasterPayload } from '../raster-payload';
import { adoptBakedImages } from '../baked-images';
import { appearanceMapping } from '../settings.js';
import { calibratePdfAppearance } from './calibration.js';

function abort(signal: AbortSignal): void { signal.throwIfAborted(); }

/** Pixel readback only. Native code owns projection, old-surface sampling and alpha composition. */
export async function preparePdfPagePreview(options: {
  snapshot: AppearanceSnapshot; productIds: number[]; source: AppearanceSourceOption;
  settings: AppearanceDraftSettings;
  planner: ReturnType<typeof createAppearancePlanner>; owner: AppearanceAssetOwner; signal: AbortSignal;
  /** Reviewed face selections of converted products (#4404); omitted textures whole surfaces. */
  faceMasks?: AppearanceFaceMask[];
}) {
  const { snapshot, productIds, source, settings, planner, owner, signal } = options;
  const pdf = source.pdf;
  if (!pdf || !source.calibration || !source.assetId) throw new Error('Choose two page points and enter their measured distance.');
  const orientation = appearanceMapping({ ...settings, kind: 'planar' });
  if (orientation.kind !== 'planar') throw new Error('PDF pages need planar placement.');
  const normals: Record<AppearanceDraftSettings['plane'], [number, number, number]> = {
    xy: [0, 0, 1], xz: [0, -1, 0], yz: [1, 0, 0],
  };
  const calibration = await calibratePdfAppearance(pdf.recipe, source.calibration, {
    worldAnchor: orientation.origin, worldDirection: orientation.axisU, planeNormal: normals[settings.plane],
  });
  abort(signal); snapshot.validate();
  const { sourceImage: page, sourceImages, rgba } = await prepareAppearanceRasterPayload(snapshot.modelId, productIds, source.assetId, owner, signal, snapshot.validate);
  const result = await planner.pagePlan(snapshot.bytes, {
    appearance: { schema: snapshot.schema, sourceRevision: snapshot.revision, nextExpressId: snapshot.nextExpressId,
      productIds, imageUri: modelAppearanceAssets.getAuthoredUri(snapshot.modelId, source.assetId),
      repeatS: false, repeatT: false, representationPolicy: settings.representationPolicy ?? 'preserve', mapping: calibration.mapping,
      ...(options.faceMasks ? { faceMasks: options.faceMasks } : {}) },
    page, sourceImages,
    texelsPerMetre: Math.max(pdf.recipe.pixelWidth / calibration.mapping.metresPerTile[0],
      pdf.recipe.pixelHeight / calibration.mapping.metresPerTile[1]),
  }, rgba, { signal });
  abort(signal); snapshot.validate();
  const imagesOut = await adoptBakedImages(snapshot.modelId, result, owner, signal);
  abort(signal); snapshot.validate();
  return { plan: result.plan, ...imagesOut };
}
