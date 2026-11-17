/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createViewpoint, translateViewpoint, sectionPlaneToClippingPlane, type BCFViewpoint, type ViewerCameraState } from '@ifc-lite/bcf';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';
import { resolveCapturedRefGlobalIds, resolveUniqueGlobalIds, type ComponentRef } from '../bcfIdLookup';
import { toast } from '@/components/ui/toast';
import { captureVisibility, describeVisibilityNotice } from './visibility-capture';
import { visibilityModelIdsForCapture } from './visibility-model-ids';
import { capturedSectionPlaneInput } from './section-plane-position';
import { focusedClashComponents } from './focused-clash-components';
import { activeSectionPlane, cardinalSectionFlipped, clippingSectionPlanes } from '@/store/section-active';
import { bcfWorldOffset, renderFrameBounds } from './viewpoint-world-frame';
import { captureBcfFrame } from './capture-frame';
import type { CreateViewpointOptions } from './viewpoint-options';
export function bcfCameraState(renderer: Renderer | null): ViewerCameraState | null {
  if (!renderer) return null;
  const camera = renderer.getCamera();
  return { position: camera.getPosition(), target: camera.getTarget(), up: camera.getUp(), fov: camera.getFOV(),
    isOrthographic: camera.getProjectionMode() === 'orthographic', orthoScale: camera.getOrthoSize() * 2, aspectRatio: camera.getAspect() };
}
/** Capture preserves the native selection/visibility identity before GPU readback yields. */
export async function captureNativeBcfViewpoint(renderer: Renderer | null, canvas: HTMLCanvasElement | null, opts: CreateViewpointOptions = {}): Promise<BCFViewpoint | null> {
  const models = useViewerStore.getState().models;
  const getBounds = () => renderFrameBounds(models);
  const getWorldOffset = () => bcfWorldOffset(models, useViewerStore.getState().geometryResult);
  const getCameraState = () => bcfCameraState(renderer);
  const captureFrame = () => captureBcfFrame(renderer, canvas, getCameraState);
  const {
    includeSnapshot = true, snapshotOverride, capturedSectionPlane,
    includeSelection = true,
    includeHidden = true,
  } = opts;
  const componentState = useViewerStore.getState();
  if (opts.isCaptureStillValid && !opts.isCaptureStillValid()) return null;
  // Default the found objects to the focused clash, whichever panel is capturing (#4806).
  const focusedClash = includeSelection
    ? focusedClashComponents(componentState.clashHighlightColors)
    : null;
  const additionalSelectedRefs = opts.additionalSelectedRefs ?? focusedClash?.selectedRefs;
  const additionalColoredRefs = opts.additionalColoredRefs ?? focusedClash?.coloredRefs;
  const resolveCapturedRef = (ref: ComponentRef): string[] => resolveCapturedRefGlobalIds(
    ref,
    componentState.models.keys(),
    (modelId, globalId) => componentState.resolveGlobalIdInModel(modelId, globalId),
    entityRef => resolveEntityRefGlobalIdFromState(componentState, entityRef),
  );
  const isCapturedRefPending = (globalId: number): boolean => {
    for (const [modelId, model] of componentState.models) {
      if (!componentState.resolveGlobalIdInModel(modelId, globalId)) continue;
      if (!model.ifcDataStore && model.loadState !== 'error') return true;
    }
    return false;
  };
  const hasCapturedRefWithoutGlobalId = (globalId: number): boolean => {
    for (const modelId of componentState.models.keys()) {
      const entityRef = componentState.resolveGlobalIdInModel(modelId, globalId);
      if (!entityRef) continue;
      if (!resolveEntityRefGlobalIdFromState(componentState, entityRef)) return true;
    }
    return false;
  };
  // Bind component identity before snapshot capture can yield. A model
  // replacement may reuse the same local express id for another entity.
  const selectedRefs: ComponentRef[] = [];
  if (includeSelection) {
    if (componentState.selectedEntityId !== null) selectedRefs.push(componentState.selectedEntityId);
    for (const id of componentState.selectedEntityIds) {
      if (id !== componentState.selectedEntityId) selectedRefs.push(id);
    }
  }
  selectedRefs.push(...(additionalSelectedRefs ?? []));
  const selectedGuids = resolveUniqueGlobalIds(selectedRefs, resolveCapturedRef);
  const seenGuids = new Set(selectedGuids);
  for (const guid of opts.additionalSelectedGuids ?? []) {
    if (!seenGuids.has(guid)) { seenGuids.add(guid); selectedGuids.push(guid); }
  }
  const emittedColoredGuids = new Set<string>();
  const coloredGuids = [
    ...(additionalColoredRefs ?? []).map(({ color, refs }) => ({
      color, guids: resolveUniqueGlobalIds(refs, resolveCapturedRef, emittedColoredGuids),
    })),
    ...(opts.additionalColoredGuids ?? []).map(({ color, guids }) => ({
      color, guids: resolveUniqueGlobalIds(guids, (guid) => guid, emittedColoredGuids),
    })),
  ].filter((entry) => entry.guids.length > 0);
  // Capture visibility in the same pre-await state as the drawing buffer.
  // GPU completion below can yield long enough for another UI action to
  // mutate the store; mixing that newer state with the older PNG makes a
  // viewpoint reopen differently from its snapshot.
  const visibilityState = includeHidden ? componentState : undefined;
  if (visibilityState && opts.onVisibilityModelIdsCaptured) {
    opts.onVisibilityModelIdsCaptured(
      visibilityModelIdsForCapture(visibilityState, (id) => resolveCapturedRef(id)),
    );
  }

  // The central capture reads camera metadata just after its full render,
  // then owns that drawing buffer through completion and image readback.
  let snapshot: string | undefined = snapshotOverride;
  let cameraState: ViewerCameraState | null = null;
  if (!snapshot && includeSnapshot) {
    const frame = await captureFrame();
    if (opts.isCaptureStillValid && !opts.isCaptureStillValid()) return null;
    if (frame) { snapshot = frame.snapshot; cameraState = frame.camera; }
  }
  cameraState ??= getCameraState();
  if (!cameraState) {
    console.warn('[useBCF] Cannot create viewpoint: no camera state');
    return null;
  }

  const bounds = getBounds() ?? undefined;
  const capturedSection = capturedSectionPlane ? capturedSectionPlaneInput(capturedSectionPlane, bounds) : null;
  // Only the cut on screen: `enabled` outlives the Section tool (#4806).
  const shown = activeSectionPlane(componentState);
  // A section box has no plane to export (BCF clips with planes): it is left out, not written as the
  // axis and position it carried from before it was a box.
  const shownPlane = shown && !shown.box ? shown : null;
  const viewerSectionPlane = capturedSection?.sectionPlane
    ?? (shownPlane ? { axis: shownPlane.axis, position: shownPlane.position, enabled: true, flipped: cardinalSectionFlipped(shownPlane) } : undefined);
  const viewpointBounds = capturedSection?.bounds ?? bounds;
  // The other cutting planes ride along (#7545): the viewpoint is what the screen shows, and the
  // screen keeps only what ALL of them keep. The active plane leads, as captured above. They are
  // placed against the model's own bounds: `viewpointBounds` may be the collapsed box a captured
  // 2D section needs for ITS axis, which would move every other axis's plane to the midpoint.
  const others = bounds
    ? clippingSectionPlanes(componentState).filter((p) => p.id !== shown?.id && !p.box)
      .map((p) => sectionPlaneToClippingPlane({ axis: p.axis, position: p.position, enabled: true, flipped: cardinalSectionFlipped(p) }, bounds))
      .filter((plane): plane is NonNullable<typeof plane> => plane !== null)
    : [];

  // Visibility GUIDs — the isolate allowlist or the hide-list, whichever the
  // viewer is in; what could not be named is reported to the author.
  // Pure decision in hooks/bcf/visibility-capture.ts (#4509, #4529).
  let hiddenGuids: string[] | undefined;
  let visibleGuids: string[] | undefined;
  if (visibilityState) {
    const capture = captureVisibility(
      visibilityState.isolatedEntities,
      visibilityState.hiddenEntities,
      resolveCapturedRef,
      isCapturedRefPending,
      hasCapturedRefWithoutGlobalId,
    );
    ({ visibleGuids, hiddenGuids } = capture);
    let notice = capture.notice;
    if (visibilityState.isolatedEntities !== null
      && opts.additionalVisibleGuids?.length
      && !notice?.pending) {
      visibleGuids = [...new Set([...(visibleGuids ?? []), ...opts.additionalVisibleGuids])];
      if (notice && visibleGuids.length > 0) notice = { ...notice, omitted: false };
    }
    if (notice) {
      const { unnameable, total, kind, omitted, pending, ids } = notice;
      console.warn(
        `[useBCF] ${unnameable} of ${total} ${kind} entities have no resolvable IFC GlobalId${pending ? ' (model metadata still loading)' : ''}; ${omitted ? 'omitting the viewpoint visibility component' : 'recording the rest'}. Global ids: ${ids.join(', ')}`,
      );
      const message = describeVisibilityNotice(notice);
      if (message) toast.info(message);
    }
  }

  // Camera and section plane are captured in the render frame; the
  // viewpoint is stored and written in world coordinates (#4806).
  const viewpoint = createViewpoint({
    camera: cameraState,
    sectionPlanes: viewerSectionPlane ? [viewerSectionPlane] : [],
    bounds: viewpointBounds,
    snapshot,
    selectedGuids,
    hiddenGuids,
    visibleGuids,
    coloredGuids,
  });
  if (others.length > 0) viewpoint.clippingPlanes = [...(viewpoint.clippingPlanes ?? []), ...others];
  return translateViewpoint(viewpoint, getWorldOffset());
}
