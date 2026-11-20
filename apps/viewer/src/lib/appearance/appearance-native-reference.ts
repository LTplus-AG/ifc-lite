/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Renderer } from '@ifc-lite/renderer';
import type { TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { appearanceAssets } from './model-assets';
import { placementFrameKey } from '@/lib/model-placement/persistence';
import { referenceRenderCorners } from './reference-runtime/frame';
import { calibrateAppearancePlane, type PlaneCalibrationRequest } from './plane-calibration';
import { pdfCalibrationFrame } from './pdf/calibration';
import { imageCalibrationFrame } from './raster-calibration';
import { appearanceMapping } from './settings';
import { captureReferencePdfLineage } from './references/pdf-lineage';
import type { AppearanceDraftSettings, AppearanceSourceOption } from './draft-types';
import type { RegisteredAppearanceReference } from './references/types';
import type { AppearanceAssetOwner } from './assets';
export class ReferenceAppearanceError extends Error {
  constructor(readonly translationKey: TranslationKey) {
    super(translationKey);
  }
}
const normals = { xy: [0, 0, 1], xz: [0, -1, 0], yz: [1, 0, 0] } satisfies Record<string, [number, number, number]>;
/** Native calibration/immutable source lineage shared by panel and operations. */
export async function prepareNativeAppearanceReference(
  source: AppearanceSourceOption,
  settings: AppearanceDraftSettings,
  frameKey: string,
  editing: RegisteredAppearanceReference | null,
  owner: AppearanceAssetOwner,
  signal: AbortSignal,
) {
  if (useViewerStore.getState().collabRoomId) throw new ReferenceAppearanceError('appearance.reference.leaveRoom');
  if (!source.calibration) throw new ReferenceAppearanceError('appearance.reference.calibrate');
  const mapping = appearanceMapping({ ...settings, kind: 'planar' });
  if (mapping.kind !== 'planar') throw new ReferenceAppearanceError('appearance.reference.planarPlacementRequired');
  const calibration: PlaneCalibrationRequest = {
    ...(source.calibrationFrame ??
      (source.pdf ? pdfCalibrationFrame(source.pdf.recipe) : imageCalibrationFrame(source.width, source.height))),
    ...source.calibration,
    worldAnchor: mapping.origin,
    worldDirection: mapping.axisU,
    planeNormal: normals[settings.plane],
  };
  const result = await calibrateAppearancePlane(calibration);
  signal.throwIfAborted();
  if (result.rasterCorners.length !== 4) throw new ReferenceAppearanceError('appearance.reference.incompleteCorners');
  const [a, b, c, d] = result.rasterCorners;
  const record: RegisteredAppearanceReference = {
    id: editing?.id ?? crypto.randomUUID(),
    sourceId: source.id,
    assetId: source.assetId ?? source.id,
    cornersIfcWorld: [a, b, c, d],
    frameKey,
    visible: editing?.visible ?? true,
    locked: false,
    opacity: editing?.opacity ?? 1,
    calibration,
    pdf: captureReferencePdfLineage(source, calibration),
  };
  const corners = referenceRenderCorners(record, useViewerStore.getState());
  if (!corners) throw new ReferenceAppearanceError('appearance.reference.workspaceFrameChanged');
  appearanceAssets.retain(record.assetId, owner);
  const bitmap = await appearanceAssets.decode(record.assetId, owner, signal);
  signal.throwIfAborted();
  return { record, source, bitmap, corners, signal };
}
export type NativeAppearanceReference = Awaited<ReturnType<typeof prepareNativeAppearanceReference>>;
/** Refuse a placement whose room, workspace frame or source changed since preparation. */
export function assertReferencePlacementCurrent(prepared: Pick<NativeAppearanceReference, 'record' | 'source'>) {
  const state = useViewerStore.getState();
  if (
    state.collabRoomId ||
    placementFrameKey(state) !== prepared.record.frameKey ||
    state.appearanceSources.find((item) => item.id === prepared.record.sourceId) !== prepared.source
  )
    throw new ReferenceAppearanceError('appearance.reference.sourceChanged');
}

/** Rendering is prepared before the synchronous native history publication.
 * Any refusal removes only the provisional reference, leaving an edit's old record. */
export async function placeNativeAppearanceReference(
  prepared: Pick<NativeAppearanceReference, 'record' | 'source' | 'bitmap'>,
  renderer: Renderer,
  signal: AbortSignal,
  editing: RegisteredAppearanceReference | null,
  commit?: <T>(write: () => T) => T,
) {
  const { record, bitmap } = prepared;
  const owner = { kind: 'draft' as const, id: `reference-place:${crypto.randomUUID()}` };
  try {
    appearanceAssets.retain(record.assetId, owner);
    signal.throwIfAborted();
    const corners = referenceRenderCorners(record, useViewerStore.getState());
    if (!corners) throw new ReferenceAppearanceError('appearance.reference.workspaceFrameChanged');
    if (!editing) await renderer.getReferenceImages().set({ ...record, corners, bitmap }, signal);
    signal.throwIfAborted();
    const write = () => {
      const state = useViewerStore.getState();
      assertReferencePlacementCurrent(prepared);
      if (editing) {
        if (state.appearanceReferences.get(editing.id) !== editing)
          throw new ReferenceAppearanceError('appearance.reference.drawingChanged');
        state.replaceAppearanceReference(editing.id, record);
      } else state.addAppearanceReference(record);
      state.selectAppearanceReference(record.id);
      return record;
    };
    return commit ? commit(write) : write();
  } catch (error) {
    if (!useViewerStore.getState().appearanceReferences.has(record.id)) renderer.getReferenceImages().remove(record.id);
    throw error;
  } finally {
    appearanceAssets.releaseOwner(owner);
  }
}
