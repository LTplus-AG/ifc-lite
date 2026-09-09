/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { appearanceAssets } from '../model-assets.js';
import { DEFAULT_APPEARANCE_SETTINGS } from '../settings.js';
import type { AppearanceDraftSettings, AppearanceSourceOption } from '../draft-types.js';
import type { RegisteredAppearanceReference } from './types.js';

/** Restore display controls only for a plane they can represent exactly. Never
 * project an imported oblique registration onto the nearest principal plane. */
export function referenceEditSettings(record: RegisteredAppearanceReference): AppearanceDraftSettings {
  if (record.locked) throw new Error('Unlock this drawing before editing its registration.');
  const recipe = record.calibration;
  if (!recipe) throw new Error('This imported registration has no calibration recipe. Place a new reference to calibrate it.');
  const length = Math.hypot(...recipe.planeNormal);
  const normal = recipe.planeNormal.map(value => value / length);
  const planes = [
    { plane: 'xy' as const, normal: [0, 0, 1], u: 0, v: 1, omitted: 2 },
    { plane: 'xz' as const, normal: [0, -1, 0], u: 0, v: 2, omitted: 1 },
    { plane: 'yz' as const, normal: [1, 0, 0], u: 1, v: 2, omitted: 0 },
  ];
  const plane = planes.find(candidate => candidate.normal.every((value, index) => Math.abs(value - normal[index]) < 1e-12));
  const direction = recipe.worldDirection;
  if (!plane || Math.abs(direction[plane.omitted]) > 1e-12 * Math.hypot(...direction)) {
    throw new Error('This drawing uses a custom plane. Its registration is preserved; editing custom planes is not available in these controls.');
  }
  return { ...DEFAULT_APPEARANCE_SETTINGS, plane: plane.plane,
    rotationDegrees: Math.atan2(direction[plane.v], direction[plane.u]) * 180 / Math.PI,
    offsetU: recipe.worldAnchor[0], offsetV: recipe.worldAnchor[1], offsetW: recipe.worldAnchor[2],
    repeatS: false, repeatT: false };
}

/** A snapshot is an ordinary source with its own lease. It does not resurrect a
 * removed PDF or bind a committed drawing to that document's current page. */
export function restoreReferenceSource(record: RegisteredAppearanceReference): AppearanceSourceOption {
  const recipe = record.calibration;
  if (!recipe) throw new Error('The drawing has no calibration recipe.');
  const asset = appearanceAssets.get(record.assetId);
  if (!asset) throw new Error('Relink the original drawing image before editing.');
  if (asset.width !== recipe.rasterSize[0] || asset.height !== recipe.rasterSize[1]) {
    throw new Error('The registered calibration does not match its original image dimensions.');
  }
  const state = useViewerStore.getState();
  const id = `reference:${record.id}:${record.assetId}`;
  const previous = state.appearanceSources.find(source => source.id === id);
  const name = state.appearanceSources.find(source => source.id === record.sourceId)?.name ?? 'Registered drawing';
  const thumbnailUrl = previous?.thumbnailUrl ?? URL.createObjectURL(new Blob([appearanceAssets.encoded(asset.id)], { type: asset.mimeType }));
  const owner = { kind: 'source' as const, id: `appearance:${id}` };
  const source: AppearanceSourceOption = { id, assetId: asset.id, name: previous?.name ?? `${name} (registered image)`,
    width: asset.width, height: asset.height, thumbnailUrl,
    calibrationFrame: { rasterToSource: [...recipe.rasterToSource], rasterSize: [...recipe.rasterSize] },
    calibration: { sourcePoints: [[...recipe.sourcePoints[0]], [...recipe.sourcePoints[1]]], distanceMetres: recipe.distanceMetres } };
  appearanceAssets.retain(asset.id, owner);
  try {
    if (previous) state.updateAppearanceSource(source); else state.addAppearanceSource(source);
    return source;
  } catch (error) {
    if (!useViewerStore.getState().appearanceSources.some(item => item.id === id)) {
      appearanceAssets.releaseOwner(owner); URL.revokeObjectURL(thumbnailUrl);
    }
    throw error;
  }
}
