/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store's cutting planes in the terms `resolveKeptHalfSpace` needs (#7545):
 * one `ViewSectionResolveInput` per plane that clips what is on screen. The PDF
 * view export cuts its sheet with them, and "zoom to the cut area" clips the model
 * bounds with the same half-spaces, so both agree with the screen.
 */

import type { GeometryResult } from '@ifc-lite/geometry';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { activeSectionPlane } from '@/store/section-active';
import { boxHoldingPlane } from './section-render-clip';
import type { SectionPlane } from '@/store/types';
import type { useViewerStore } from '@/store';
import type { ViewSectionResolveInput } from '@/lib/export/view-pdf/view-section-plane';

type ViewerState = ReturnType<typeof useViewerStore.getState>;

/**
 * The cut to apply, in the terms `resolveKeptHalfSpace` needs.
 *
 * Returns `null` when the user has no cut enabled, or when the renderer has no
 * scene bounds yet — the percentage is meaningless without the range it is a
 * percentage OF, and inventing one would place the cut somewhere the screen
 * never shows.
 */
export function resolveSectionInput(state: ViewerState): ViewSectionResolveInput | null {
  // Only the cut on screen: the sheet is the view (#4910).
  const sectionPlane = activeSectionPlane(state);
  // A box has no plane: it clips by its six faces (`resolveBoxSectionInputs`), never by the axis and
  // position it carries from before it was a box.
  return sectionPlane && !sectionPlane.box ? resolvePlaneInput(state, sectionPlane) : null;
}

/** The cutting planes beyond the active one that are on screen (#7545), in creation order. */
export function resolveExtraSectionInputs(state: ViewerState): ViewSectionResolveInput[] {
  if (!(state.sceneState?.section?.visible ?? true)) return [];
  const out: ViewSectionResolveInput[] = [];
  for (const plane of state.inactiveSectionPlanes) {
    const input = plane.enabled && !plane.box ? resolvePlaneInput(state, plane) : null;
    if (input) out.push(input);
  }
  return out;
}

/**
 * The section box as six half-spaces, one per face (explicit normal and distance, used verbatim), when a
 * box is cutting on screen: the same box the renderer clips by (`boxHoldingPlane`).
 */
export function resolveBoxSectionInputs(state: ViewerState): ViewSectionResolveInput[] {
  if (!(state.sceneState?.section?.visible ?? true)) return [];
  const holder = boxHoldingPlane(state.sectionPlane, state.inactiveSectionPlanes);
  const box = holder?.enabled ? holder.box : undefined;
  const sceneBounds = getGlobalRenderer()?.getCamera()?.getSceneBounds() ?? null;
  if (!box || !sceneBounds) return [];
  const face = (normal: [number, number, number], distance: number): ViewSectionResolveInput => ({
    plane: { axis: 'down', position: 0, flipped: false, custom: { normal, distance } },
    sceneBounds,
    uiRange: null,
  });
  return [
    face([1, 0, 0], box.max[0]), face([-1, 0, 0], -box.min[0]),
    face([0, 1, 0], box.max[1]), face([0, -1, 0], -box.min[1]),
    face([0, 0, 1], box.max[2]), face([0, 0, -1], -box.min[2]),
  ];
}

export function resolvePlaneInput(state: ViewerState, sectionPlane: SectionPlane): ViewSectionResolveInput | null {
  const sceneBounds = getGlobalRenderer()?.getCamera()?.getSceneBounds() ?? null;
  if (!sceneBounds) return null;

  const coordinateInfo = visibleCoordinateInfo(state);
  const axisKey = sectionPlane.axis === 'side' ? 'x' : sectionPlane.axis === 'down' ? 'y' : 'z';
  const shifted = coordinateInfo?.shiftedBounds;
  const uiRange = shifted
    ? { min: shifted.min[axisKey], max: shifted.max[axisKey] }
    : null;

  return {
    plane: {
      axis: sectionPlane.axis,
      position: sectionPlane.position,
      flipped: sectionPlane.flipped,
      custom: sectionPlane.custom
        ? { normal: sectionPlane.custom.normal, distance: sectionPlane.custom.distance }
        : undefined,
    },
    sceneBounds,
    buildingRotation: coordinateInfo?.buildingRotation,
    uiRange,
  };
}

/**
 * Coordinate info for the section percentage, with `shiftedBounds` UNIONED
 * across every visible model.
 *
 * The first visible model's own bounds are not enough. `ViewportContainer`
 * hands the renderer the union of all visible models' `shiftedBounds`, so the
 * on-screen cut resolves its percentage against that union. Reading only the
 * first model here makes the same 50% land somewhere else entirely on a
 * federated view: with a small model loaded first, 50% could resolve to x=5 in
 * the PDF while the screen resolves it to x=55. The cut has to be derived from
 * the same range the viewport used, or the sheet is not the view.
 *
 * Non-bounds fields (notably `buildingRotation`) stay with the first visible
 * model, matching `ViewportContainer`'s own base-plus-unioned-bounds shape.
 */
export function visibleCoordinateInfo(state: ViewerState): GeometryResult['coordinateInfo'] | null {
  let base: GeometryResult['coordinateInfo'] | null = null;
  let unioned: Bounds3D | null = null;

  for (const model of state.models.values()) {
    if (!model.visible || !model.geometryResult) continue;
    const info = model.geometryResult.coordinateInfo;
    base ??= info;
    unioned = unionBounds3D(unioned, info?.shiftedBounds);
  }
  if (!base) return state.geometryResult?.coordinateInfo ?? null;
  return unioned ? { ...base, shiftedBounds: unioned } : base;
}

interface Bounds3D {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/** Axis-aligned union, skipping absent or non-finite boxes. */
function unionBounds3D(acc: Bounds3D | null, b: Bounds3D | undefined): Bounds3D | null {
  if (!b) return acc;
  const finite = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite);
  if (!finite) return acc;
  if (!acc) return { min: { ...b.min }, max: { ...b.max } };
  return {
    min: {
      x: Math.min(acc.min.x, b.min.x),
      y: Math.min(acc.min.y, b.min.y),
      z: Math.min(acc.min.z, b.min.z),
    },
    max: {
      x: Math.max(acc.max.x, b.max.x),
      y: Math.max(acc.max.y, b.max.y),
      z: Math.max(acc.max.z, b.max.z),
    },
  };
}

/** Every plane that clips the screen, the active one first: the cut the sheet and the cut area are about. */
export function resolveClippingSectionInputs(state: ViewerState): ViewSectionResolveInput[] {
  const first = resolveSectionInput(state);
  return [...(first ? [first] : []), ...resolveExtraSectionInputs(state), ...resolveBoxSectionInputs(state)];
}
