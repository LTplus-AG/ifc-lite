/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expandAppearanceCorners, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import type { AppearanceSnapshot } from './snapshot';
import type { AppearancePlanner } from './planner-worker-client';
import type { AppearanceAssetOwner } from './assets';
import type { AppearanceDraftSettings, AppearanceSourceOption } from './draft-types';
import type { AppearanceRequest } from './planner-types';
import { appearanceAssets, modelAppearanceAssets } from './model-assets';
import { appearanceMapping } from './settings';
import { preparePdfPagePreview } from './pdf/page-preview';
import { AppearancePreviewSession, bindAppearancePreview } from './preview';

/** Native Rust planning and retained image preparation shared by panel and operations. */
export async function prepareNativeAppearancePlan(input: {
  snapshot: AppearanceSnapshot; productIds: number[]; sourceId: string; selectedSource?: AppearanceSourceOption;
  settings: AppearanceDraftSettings; planner: AppearancePlanner; owner: AppearanceAssetOwner;
  signal: AbortSignal; faceMasks?: AppearanceRequest['faceMasks'];
}) {
  const { snapshot, productIds, sourceId, selectedSource, settings, planner, owner, signal, faceMasks } = input;
  const { modelId, source, schema, nextExpressId, bytes } = snapshot;
  const assetId = selectedSource?.assetId ?? sourceId;
  const page = selectedSource?.pdf ? await preparePdfPagePreview({ snapshot, productIds,
    source: selectedSource, settings, planner, owner, signal, faceMasks }) : undefined;
  const firstPageImage = page?.itemImages.values().next().value;
  const imageUri = page ? firstPageImage?.imageUri ?? '' : modelAppearanceAssets.getAuthoredUri(modelId, assetId);
  if (!page) appearanceAssets.retain(assetId, owner);
  const bitmap = page ? firstPageImage?.bitmap : await appearanceAssets.decode(assetId, owner, signal);
  snapshot.validate();
  const plan = page?.plan ?? await planner.plan(bytes, { schema, sourceRevision: snapshot.revision, nextExpressId,
    productIds, imageUri, repeatS: settings.repeatS, repeatT: settings.repeatT,
    representationPolicy: settings.representationPolicy ?? 'preserve', mapping: appearanceMapping(settings),
    ...(faceMasks ? { faceMasks } : {}) }, { signal });
  signal.throwIfAborted(); snapshot.validate();
  return { source, assetIds: page?.assetIds ?? [assetId], plan, bitmap, imageUri, itemImages: page?.itemImages };
}
export function stageNativeAppearancePreview(modelId: string, prepared: Awaited<ReturnType<typeof prepareNativeAppearancePlan>>, settings: AppearanceDraftSettings, renderer: Renderer) {
  if (!prepared.bitmap) throw new Error('The native appearance image is unavailable.');
  const groups = bindAppearancePreview(useViewerStore.getState(), renderer, modelId, prepared.plan, prepared.bitmap,
    prepared.imageUri, settings.repeatS, settings.repeatT, expandAppearanceCorners, prepared.itemImages);
  const session = new AppearancePreviewSession(renderer); session.stage(groups); return { groups, session };
}
