/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Selection handler functions extracted from useMouseControls.
 * Handles click/double-click selection and context menu interactions.
 * Pure functions operating on a MouseHandlerContext — no React dependency.
 */
import { isTouchSelectionClick, selectViewportTarget } from './referenceSelection.js';
import type { PickResult } from '@ifc-lite/renderer';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { openContextMenuAt } from './contextMenuSelection.js';
import { useViewerStore } from '@/store';
import { fromGlobalIdFromModels, toGlobalIdFromModels } from '@/store/globalId';
import { toast } from '@/components/ui/toast';
import { routeCommandPointer } from './commandPointer.js';
import { raycastForPolylinePoint, isNearPolylineStart,
  isDuplicateClickPoint,
} from './measureHandlers.js';
import { pickViewportAppearanceFace, viewportFacePickError } from './appearance/face-mask/viewport-face-picker.js';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state.js';
import { resolve as translate } from '@/i18n/registry';
import { fromRenderTranslation } from '@/lib/model-placement/translation.js';
import { workspacePointToModelFrame } from '@/lib/model-placement/rotation.js';
import { effectiveStoreyElevation, selectEffectiveStoreyId } from './add-element-storeys.js';

/** The click-driven Measure modes' point placement; also a touch tap's (#5856). */
export function handleMeasureClickAt(ctx: MouseHandlerContext, x: number, y: number): void {
  const mode = useViewerStore.getState().measureMode;
  if (mode === 'polyline') handlePolylineClick(ctx, x, y);
  else if (mode === 'angle') handleAngleClick(ctx, x, y);
  else if (mode === 'radius') handleRadiusClick(ctx, x, y);
}

export async function handleSelectionClick(ctx: MouseHandlerContext, e: MouseEvent): Promise<void> {
  const { canvas, renderer, mouseState } = ctx;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const tool = ctx.activeToolRef.current;
  if (isTouchSelectionClick(canvas, e, x, y)) return;

  // Skip selection if user was dragging (orbiting/panning)
  if (mouseState.didDrag) {
    return;
  }

  // Skip selection for pan/walk tools - they don't select
  if (tool === 'pan' || tool === 'walk') {
    return;
  }

  if (tool === 'appearance-face') {
    const message = viewportFacePickError(pickViewportAppearanceFace(renderer.raycastScene(x, y, ctx.getPickOptions())?.intersection ?? null));
    if (message) toast.error(translate(message));
    return;
  }

  // Measure tool: drag mode uses mousedown/mousemove/mouseup (see
  // measureHandlers.ts) and never reaches here. Polyline mode (#2199) is the
  // opposite — it does nothing on mousedown/drag, so a click is the ONLY
  // gesture that adds a point, which is what makes the two modes unable to
  // corrupt each other's state (see `setMeasureMode` in measurementSlice.ts).
  if (tool === 'measure') return handleMeasureClickAt(ctx, x, y);

  // Section-tool face-pick (issue #243): clicking any visible face places
  // the clip plane through it. Intercept BEFORE the generic select path
  // so the click doesn't also flip the selection.
  //
  // Camera-aware orientation: we flip the picked normal if it faces away
  // from the camera, so the kept half-space is the one the user is looking
  // at by default (the most common expectation; if the cut goes the wrong
  // way the existing Flip button still works). This addresses the
  // CodeRabbit minor on PR #581 about face-pick not being camera-aware.
  if (tool === 'section' && ctx.sectionPickModeRef?.current) {
    const hit = renderer.raycastScene(x, y, {
      hiddenIds:   ctx.hiddenEntitiesRef.current,
      isolatedIds: ctx.isolatedEntitiesRef.current,
    });
    if (hit?.intersection) {
      const n = hit.intersection.normal;
      const p = hit.intersection.point;
      const cam = renderer.getCamera().getPosition();
      // View vector = camera → hit. If `dot(view, normal) > 0` the normal
      // points away from the camera; invert so the cut keeps the side
      // facing the user.
      const vx = cam.x - p.x, vy = cam.y - p.y, vz = cam.z - p.z;
      const dot = vx * n.x + vy * n.y + vz * n.z;
      const sign = dot < 0 ? -1 : 1;
      const bounds = ctx.modelBoundsRef?.current;
      ctx.setSectionPlaneFromFace?.(
        [sign * n.x, sign * n.y, sign * n.z],
        [p.x, p.y, p.z],
        bounds ? {
          min: [bounds.min.x, bounds.min.y, bounds.min.z],
          max: [bounds.max.x, bounds.max.y, bounds.max.z],
        } : undefined,
      );
    } else {
      // Missed geometry — disarm so the user isn't stuck in pick mode
      // after an errant background click.
      ctx.setSectionPickMode?.(false);
    }
    return;
  }

  // A running modeling command takes the click (#6232, commandPointer.ts).
  if (tool === 'command') { routeCommandPointer(ctx, 'down', x, y, e); return; }

  // Add-element tool — multi-click placement (start→end for beams/members,
  // corner→opposite for slab rectangle, N+Enter for slab polygon, single
  // for columns). Uses magnetic snap so points lock to vertices/edges
  // when the cursor is near them — same UX as the measure tool.
  if (tool === 'addElement') {
    const currentLock = ctx.edgeLockStateRef.current;
    const result = renderer.raycastSceneMagnetic(x, y, {
      edge: currentLock.edge,
      meshExpressId: currentLock.meshExpressId,
      lockStrength: currentLock.lockStrength,
    }, {
      hiddenIds: ctx.hiddenEntitiesRef.current,
      isolatedIds: ctx.isolatedEntitiesRef.current,
      snapOptions: ctx.snapEnabledRef.current ? {
        snapToVertices: true,
        snapToEdges: true,
        snapToFaces: true,
        screenSnapRadius: 40,
      } : {
        snapToVertices: false,
        snapToEdges: false,
        snapToFaces: false,
        screenSnapRadius: 0,
      },
    });
    const point = result.snapTarget?.position
      ?? result.intersection?.point
      ?? raycastStoreyFloor(ctx, x, y);
    if (!point) return;
    // Smart-placement: if the click landed on (or snapped to) an
    // existing entity, infer the target storey from THAT entity's
    // spatial-hierarchy entry rather than the AddElement panel's
    // dropdown. Lets the user click on a wall on storey 3 to add
    // a beam there without first changing the storey selector.
    // Only kicks in when we actually have an entity under the
    // cursor — empty-space clicks fall back to the panel value.
    const hitExpressId = result.snapTarget?.expressId
      ?? result.intersection?.expressId
      ?? null;
    const inferredStorey = hitExpressId !== null
      ? inferStoreyForGlobalId(hitExpressId)
      : null;
    await handleAddElementDrop(point, inferredStorey ?? undefined);
    return;
  }

  // Annotate tool — drop a pin at the cursor's world point.
  // Raycasts the scene; if the click misses geometry the draft is
  // not opened (annotations are anchored to surface points by
  // design, not floating in space).
  if (tool === 'annotate') {
    const store = useViewerStore.getState();
    // In a shared room, only commenter/editor/admin may drop pins (solo allowed).
    if (!store.canCollabComment()) return;
    const result = renderer.raycastScene(x, y, ctx.getPickOptions());
    if (!result?.intersection) return;
    const { intersection } = result;
    // Federated models — resolve which model the hit globalId belongs
    // to so the annotation carries enough context to render its
    // popover header. Falls back to (null, expressId) when there's
    // only the legacy single-model state.
    const modelLookup = fromGlobalIdFromModels(store.models, intersection.expressId);
    const modelId = modelLookup?.modelId ?? null;
    const localExpressId = modelLookup?.expressId ?? intersection.expressId;
    store.beginDraft(
      { x: intersection.point.x, y: intersection.point.y, z: intersection.point.z },
      localExpressId ?? null,
      modelId,
    );
    return;
  }

  const now = Date.now();
  const timeSinceLastClick = now - ctx.lastClickTimeRef.current;
  const clickPos = { x, y };
  const doubleClick = ctx.lastClickPosRef.current && timeSinceLastClick < 300
    && Math.abs(clickPos.x - ctx.lastClickPosRef.current.x) < 5
    && Math.abs(clickPos.y - ctx.lastClickPosRef.current.y) < 5;
  const applyIfc = (pickResult: PickResult | null) => {
    if (doubleClick) {
      if (pickResult) ctx.handlePickForSelection(pickResult);
      ctx.lastClickTimeRef.current = 0; ctx.lastClickPosRef.current = null;
    } else {
      if (e.ctrlKey || e.metaKey) { if (pickResult) ctx.toggleSelection(pickResult.expressId); }
      else ctx.handlePickForSelection(pickResult);
      ctx.lastClickTimeRef.current = now; ctx.lastClickPosRef.current = clickPos;
    }
  };
  if (tool === 'select') {
    await selectViewportTarget({ canvas, renderer, x, y, getTool: () => ctx.activeToolRef.current,
      getPickOptions: ctx.getPickOptions, onIfc: applyIfc,
      onReference: () => { ctx.lastClickTimeRef.current = 0; ctx.lastClickPosRef.current = null; } });
  } else {
    applyIfc(await renderer.pick(x, y, ctx.getPickOptions()));
  }
}

/**
 * Resolve the storey + model for a hit globalId so the AddElement
 * click handler can place the new entity in the SAME storey as the
 * existing element under the cursor. Returns null when the hit
 * doesn't resolve to any model's spatial-hierarchy entry — caller
 * falls back to the AddElement panel's storey selector.
 *
 * Federation-aware via `fromGlobalIdFromModels`.
 */
function inferStoreyForGlobalId(
  globalId: number,
): { modelId: string; storeyId: number } | null {
  const state = useViewerStore.getState();
  const local = fromGlobalIdFromModels(state.models, globalId);
  if (!local) return null;
  const ds = state.models.get(local.modelId)?.ifcDataStore;
  const storeyId = ds?.spatialHierarchy?.elementToStorey.get(local.expressId);
  if (storeyId === undefined) return null;
  return { modelId: local.modelId, storeyId };
}

/**
 * Keep an explicit selection only while it is a live storey in this model.
 * A deleted or retyped selection falls back to the next available storey.
 */
function resolveStoreyExpressId(modelId: string, preferred: number | null): number | null {
  const state = useViewerStore.getState();
  const store = state.models.get(modelId)?.ifcDataStore;
  return store ? selectEffectiveStoreyId(store, state.mutationViews.get(modelId), preferred) : null;
}

/**
 * Active model resolver — falls back through the same legacy chain
 * the rest of the viewer uses when a single model is loaded.
 */
function resolveActiveModelId(): string | null {
  const state = useViewerStore.getState();
  if (state.activeModelId) return state.activeModelId;
  const first = state.models.keys().next();
  return first.done ? null : first.value;
}

/**
 * `modelId`'s current reposition placement — translation (including an
 * in-flight move-preview drag, so a pick made mid-drag matches what is on
 * screen) and heading. The inverse `rendererPointToIfcStoreyLocal` applies
 * so a pick against a moved/rotated model lands on the point the user
 * actually clicked, not that point's un-repositioned twin (#4932).
 */
function pickPlacement(modelId: string): { translation: ReturnType<typeof displayedTranslation>; rotation: ReturnType<typeof placementFor>['rotation'] } {
  const state = useViewerStore.getState();
  return { translation: displayedTranslation(state.modelPlacement, modelId),
    rotation: placementFor(state.modelPlacement, modelId).rotation };
}

/**
 * Convert a renderer Y-up world point — picked against `modelId`'s
 * repositioned geometry — into IFC Z-up storey-local coordinates, with Z
 * forced to the storey floor (0). Inverts `modelId`'s placement (heading
 * about its pivot, then translation) before the axis swap, so authoring
 * actions fed by this (`addWall`, `splitWallAtDistance`, …), which all work
 * in the model's own un-repositioned frame, receive the point the user
 * actually clicked rather than that point's un-repositioned twin (#4932).
 * Z is clamped so a click landing on a vertical surface doesn't lift the
 * element above the floor — matches construction-tool placement intuition.
 */
export function rendererPointToIfcStoreyLocal(
  point: { x: number; y: number; z: number },
  modelId: string,
): [number, number, number] {
  const modelPoint = workspacePointToModelFrame(fromRenderTranslation(point), pickPlacement(modelId));
  return [modelPoint[0], modelPoint[1], 0];
}

/**
 * Storey-floor ray-plane intersection — used as a fallback when the
 * scene raycast misses every mesh (so the user can place new elements
 * in empty space, not just on existing surfaces). The floor sits at
 * renderer Y = storey elevation (`resolveStoreyFloorY()`, active-model lookup).
 */
function raycastStoreyFloor(
  ctx: MouseHandlerContext,
  x: number,
  y: number,
): { x: number; y: number; z: number } | null {
  const camera = ctx.renderer.getCamera();
  const canvas = ctx.renderer.getCanvas();
  if (!camera || !canvas) return null;
  // x/y arrive in CSS space (handleSelectionClick subtracts the
  // bounding-rect origin). `unprojectToRay` expects drawing-buffer
  // coords, which differ from CSS by DPR. Convert both the cursor
  // and the canvas size so the ray is computed in the same space
  // `projectToScreen` writes to — otherwise pick drifts at DPR ≠ 1.
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width > 0 ? (x / rect.width) * canvas.width : x;
  const sy = rect.height > 0 ? (y / rect.height) * canvas.height : y;
  const ray = camera.unprojectToRay(sx, sy, canvas.width, canvas.height);
  if (!ray) return null;
  const planeY = resolveStoreyFloorY();
  // Looking down typically means D.y < 0; reject parallel / near-parallel
  // cases so we don't hand back a wildly extrapolated intersection.
  const dy = ray.direction.y;
  if (Math.abs(dy) < 1e-6) return null;
  const t = (planeY - ray.origin.y) / dy;
  if (!Number.isFinite(t) || t <= 0) return null;
  return {
    x: ray.origin.x + ray.direction.x * t,
    y: planeY,
    z: ray.origin.z + ray.direction.z * t,
  };
}

/**
 * Resolve the renderer Y of the currently selected (or first
 * available) storey's floor, offset by that model's own vertical
 * reposition (#4932): a model moved up or down renders its floor there
 * too. Rotation is a yaw and never tilts the floor, so only the
 * translation's Z applies. Falls back to 0 when nothing is loaded.
 */
function resolveStoreyFloorY(): number {
  const state = useViewerStore.getState();
  const modelId = state.addElementModelId ?? state.activeModelId;
  if (!modelId) return 0;
  const model = state.models.get(modelId);
  const ds = model?.ifcDataStore;
  if (!ds) return 0;
  const storeyId = resolveStoreyExpressId(modelId, state.addElementStoreyId);
  if (storeyId === null) return 0;
  const elev = effectiveStoreyElevation(ds, state.mutationViews.get(modelId), storeyId);
  return elev + displayedTranslation(state.modelPlacement, modelId)[2];
}

/**
 * Update the live hover preview for the add-element tool. Runs the
 * same magnetic raycast as the click handler and keeps `hoverPoint`
 * in sync with whatever the next click would place. Used by the
 * 3D-overlay preview so the user sees the in-progress edge / rectangle
 * / polygon segment as they move the cursor.
 *
 * Returns true when handled so the mouse-controls hook can early-out
 * before falling through to the generic hover-tooltip path.
 */
export function handleAddElementHover(ctx: MouseHandlerContext, x: number, y: number): boolean {
  const { renderer } = ctx;
  if (!ctx.measureRaycastPendingRef.current) {
    ctx.measureRaycastPendingRef.current = true;
    ctx.measureRaycastFrameRef.current = requestAnimationFrame(() => {
      ctx.measureRaycastPendingRef.current = false;
      ctx.measureRaycastFrameRef.current = null;

      const currentLock = ctx.edgeLockStateRef.current;
      const result = renderer.raycastSceneMagnetic(x, y, {
        edge: currentLock.edge,
        meshExpressId: currentLock.meshExpressId,
        lockStrength: currentLock.lockStrength,
      }, {
        hiddenIds: ctx.hiddenEntitiesRef.current,
        isolatedIds: ctx.isolatedEntitiesRef.current,
        snapOptions: ctx.snapEnabledRef.current ? {
          snapToVertices: true,
          snapToEdges: true,
          snapToFaces: true,
          screenSnapRadius: 40,
        } : {
          snapToVertices: false,
          snapToEdges: false,
          snapToFaces: false,
          screenSnapRadius: 0,
        },
      });

      const point = result.snapTarget?.position
        ?? result.intersection?.point
        ?? raycastStoreyFloor(ctx, x, y);
      const store = useViewerStore.getState();
      store.setAddElementHoverPoint(point ? { x: point.x, y: point.y, z: point.z } : null);

      // Mirror measure's snap-viz behaviour so vertex/edge/face indicators
      // appear under the cursor with the same UX shape.
      ctx.setSnapTarget(result.snapTarget ?? null);
      if (result.snapTarget) {
        if (result.edgeLock.shouldRelease) {
          ctx.clearEdgeLock();
        } else if (result.edgeLock.shouldLock && result.edgeLock.edge) {
          ctx.setEdgeLock(result.edgeLock.edge, result.edgeLock.meshExpressId!, result.edgeLock.edgeT);
        }
      } else {
        ctx.clearEdgeLock();
      }
    });
  }
  return true;
}

/**
 * Handle a click landing on the scene while the Measure tool's polyline mode
 * is active (#2199). One click state machine, three outcomes:
 *
 *   - no sequence in progress → start one at the clicked point.
 *   - sequence in progress, click lands near the FIRST point (screen space,
 *     ≥3 points already placed) → close the loop, finishing as a perimeter.
 *   - otherwise → append the clicked point.
 *
 * Finishing an OPEN polyline is a different gesture entirely (double-click
 * or Enter — see `finishOpenPolyline`'s call sites in useMouseControls.ts /
 * useKeyboardShortcuts.ts), so a click never finishes anything but a closed
 * loop. A miss (no raycast hit) is a no-op — it neither starts nor extends
 * a sequence, matching how a drag-mode click into empty space does nothing.
 */
export function handlePolylineClick(ctx: MouseHandlerContext, x: number, y: number): void {
  const picked = raycastForPolylinePoint(ctx, x, y);
  if (!picked) return;

  const state = useViewerStore.getState();
  ctx.setSnapTarget(picked.snapTarget);

  const active = state.activePolyline;
  if (!active) {
    state.startPolyline(picked.point);
    return;
  }

  const first = active.points[0];
  if (active.points.length >= 3 && isNearPolylineStart(picked.point, first)) {
    state.finishPolyline(true);
    return;
  }

  state.addPolylinePoint(picked.point);
}

/**
 * Handle a click landing on the scene while the Measure tool's radius mode
 * is active (#2737 item 2). Same click state machine as
 * {@link handlePolylineClick} minus the close-the-loop branch — radius has
 * no "closed" concept, so a click only ever starts a sequence or extends it:
 *
 *   - no sequence in progress → start one at the clicked point.
 *   - otherwise → append the clicked point.
 *
 * Finishing is double-click or Enter (`finishRadiusFromDoubleClick`'s call
 * sites in useMouseControls.ts / useKeyboardShortcuts.ts), the same gesture
 * polyline uses and for the same reason: with an unbounded pick count there
 * is no "last pick" for the store to recognise and finish itself on, unlike
 * angle's fixed count. A miss (no raycast hit) is a no-op.
 */
export function handleRadiusClick(ctx: MouseHandlerContext, x: number, y: number): void {
  const picked = raycastForPolylinePoint(ctx, x, y);
  if (!picked) return;

  const state = useViewerStore.getState();
  ctx.setSnapTarget(picked.snapTarget);

  const active = state.activeRadius;
  if (!active) {
    state.startRadius(picked.point);
    return;
  }

  state.addRadiusPoint(picked.point);
}

/**
 * Click handler for angle mode (#2735).
 *
 * There is no finish gesture - every angle kind has a FIXED pick count and the
 * store finishes the measurement itself on the last pick - so polyline's
 * `fromDoubleClick` apparatus has no analogue here.
 *
 * But the duplicate-click DEFENCE still does, and an earlier version of this
 * comment claimed otherwise on false grounds. It argued a stray second click
 * "lands where the maths already classifies coincident picks as degenerate".
 * Only APEX-coincidence is degenerate. Browsers fire `click, click, dblclick`,
 * so a habitual double-click produces three distinct failures here:
 *
 *   1. double-clicking a DIRECTION point makes picks 2 and 3 coincide - a
 *      recorded "0.0°", rendered as a real answer rather than an em dash;
 *   2. double-clicking the THIRD pick finishes on the first click and the
 *      second click starts a stray new sequence, so "1/3 picks · apex set"
 *      appears unbidden;
 *   3. double-clicking the APEX puts picks 1 and 2 a pixel or two apart - a
 *      ray whose direction is cursor noise, and pick 3 then yields a
 *      confident, wrong `angled` number.
 *
 * So the same `isDuplicateClickPoint` guard polyline uses applies: a click
 * within {@link DUPLICATE_POINT_SCREEN_RADIUS_PX} of the previous pick is the
 * second half of one physical double-click and is dropped. Dropping is safe
 * because a genuinely intended pick that close is unmeasurable anyway.
 *
 * A miss is a no-op, matching polyline's contract.
 *
 * Only the `'points'` kind ships today; `'edges'` and `'faces'` are the later
 * slices of #2735 and will need their own pick resolution (an edge run from
 * `SnapTarget.metadata`, a camera-oriented face normal from the intersection),
 * which is why the pick carries its `kind` rather than being a bare point.
 */
export function handleAngleClick(ctx: MouseHandlerContext, x: number, y: number): void {
  const state = useViewerStore.getState();
  const kind = state.angleKind;

  // Faces need the surface normal, which only the raycast hit carries, so they
  // take a different path from the two point-based kinds rather than sharing
  // the snap-driven one. Snapping a face pick to a nearby VERTEX would move the
  // point off the surface whose normal we just read.
  if (kind === 'faces') {
    const hit = ctx.renderer?.raycastScene(x, y, {
      hiddenIds: ctx.hiddenEntitiesRef.current,
      isolatedIds: ctx.isolatedEntitiesRef.current,
    });
    const n = hit?.intersection?.normal;
    const p = hit?.intersection?.point;
    if (!n || !p) return;

    // Faces need the SAME double-click guard as the point-based kinds, which
    // this early-return path was skipping. A face pair needs exactly two picks,
    // so a physical double-click on one face recorded both halves instantly and
    // completed a bogus measurement reading "Parallel" - a plausible-looking
    // number for two picks the user never made.
    //
    // There is no shape boundary to exempt here, unlike edges: both face picks
    // belong to one measurement, and two clicks in the same spot are always the
    // same face.
    const facePrior = state.activeAngle?.picks ?? [];
    const facePrev = facePrior.length > 0 ? facePrior[facePrior.length - 1].point : null;
    const facePoint = { x: p.x, y: p.y, z: p.z, screenX: x, screenY: y };
    if (facePrev && isDuplicateClickPoint(facePrev, facePoint)) return;

    state.addAnglePick({
      kind: 'faces',
      // screen coords are the click itself, which is what the overlay
      // reprojects from; `updateMeasurementScreenCoords` refreshes them on
      // camera move exactly as it does for the other kinds.
      point: facePoint,
      normal: { x: n.x, y: n.y, z: n.z },
    });
    return;
  }

  const picked = raycastForPolylinePoint(ctx, x, y);
  if (!picked) return;

  // Drop the second half of a physical double-click (see the note above), but
  // only WITHIN a shape, never across the boundary between the two edges.
  //
  // The natural gesture for an edge pair is to trace edge A into a shared
  // corner and edge B out of it, so picks 2 and 3 are the SAME point. Guarding
  // across that boundary swallowed pick 3, the measurement never completed, and
  // the only recourse was to click slightly off the corner - degrading the very
  // direction being measured. Worse, the opposite pick order (corner first)
  // survived, so the mode worked or did not depending on which end of edge A
  // the user started from, which is not a distinction they can see.
  //
  // A shared vertex is NOT a degenerate edge: a zero-length second edge needs
  // pick 4 to coincide with pick 3, and that is still caught below.
  const prior = state.activeAngle?.picks ?? [];
  const startsNewShape = kind === 'edges' && prior.length % 2 === 0;
  const last = !startsNewShape && prior.length > 0 ? prior[prior.length - 1].point : null;
  if (last && isDuplicateClickPoint(last, picked.point)) return;

  ctx.setSnapTarget(picked.snapTarget);
  state.addAnglePick({ kind, point: picked.point });
}

/**
 * The store side of the Measure tool's double-click finish (#2199), kept
 * beside {@link handlePolylineClick} because the two are one gesture family
 * and this one reads the store directly the same way.
 *
 * This is the ONLY finish path that may drop a trailing near-duplicate point:
 * a physical double-click dispatches `click, click, dblclick`, so
 * `handlePolylineClick` has already appended the browser's second click by
 * the time this runs. Enter (useKeyboardShortcuts.ts) and the close-loop
 * click above append nothing extra, and the screen coordinates the duplicate
 * check compares are reprojected on every camera move, so passing
 * `fromDoubleClick` from anywhere else would delete real vertices after an
 * orbit — see `finishPolyline` in measurementSlice.ts.
 *
 * Returns `null` when the gesture does not apply (not in polyline mode, or
 * no sequence in progress) so the caller knows to leave the DOM event alone;
 * otherwise whether a measurement was actually recorded.
 */
export function finishPolylineFromDoubleClick(): boolean | null {
  const state = useViewerStore.getState();
  if (state.measureMode !== 'polyline' || !state.activePolyline) return null;
  return state.finishPolyline(false, { fromDoubleClick: true });
}

/**
 * The store side of the Measure tool's radius double-click finish (#2737
 * item 2) — same shape as {@link finishPolylineFromDoubleClick}, for the
 * same reason (radius is the other unbounded, explicit-finish click
 * sequence). Returns `null` when the gesture does not apply (not in radius
 * mode, or no sequence in progress); otherwise whether a measurement was
 * actually recorded.
 */
export function finishRadiusFromDoubleClick(): boolean | null {
  const state = useViewerStore.getState();
  if (state.measureMode !== 'radius' || !state.activeRadius) return null;
  return state.finishRadius({ fromDoubleClick: true });
}

/**
 * Resolve the active model + storey + a snap-aware world point.
 * Surfaces the same toast errors all add-element entry points share.
 *
 * `override` lets the caller force a specific (model, storey) pair —
 * used by smart placement so clicking on an existing element places
 * the new entity in that element's storey/model rather than the
 * AddElement panel's currently-selected one. Falls back through the
 * panel's selector (`addElementStoreyId`) and then the first storey
 * of the active model when no override is supplied.
 */
function resolveAddElementContext(
  override?: { modelId: string; storeyId: number },
): { modelId: string; storeyId: number } | null {
  const state = useViewerStore.getState();
  const modelId = override?.modelId ?? state.addElementModelId ?? resolveActiveModelId();
  if (!modelId) {
    toast.error("Couldn't add element: no model loaded");
    return null;
  }
  const storeyId = resolveStoreyExpressId(modelId, override?.storeyId ?? state.addElementStoreyId);
  if (storeyId === null) {
    toast.error("Couldn't add element: model has no IfcBuildingStorey");
    return null;
  }
  return { modelId, storeyId };
}

/** Common post-place: pick the new entity's global id, toast, clear pending. */
function finishAddElement(
  result: { expressId: number } | { error: string },
  modelId: string,
  label: string,
): void {
  const state = useViewerStore.getState();
  if ('error' in result) {
    toast.error(`Couldn't add ${label.toLowerCase()}: ${result.error}`);
    return;
  }
  const globalId = toGlobalIdFromModels(state.models, modelId, result.expressId);
  state.setSelectedEntityId(globalId);
  state.clearAddElementPending();
  toast.success(`${label} #${result.expressId} added — undo to remove`);
}

/**
 * Handle a click landing on the scene while the addElement tool is
 * active. Implements a per-type click state machine:
 *
 *   - column: 1 click → place
 *   - beam / member: 1st click → start, 2nd click → end + place
 *     (walls: the `wall.place` command)
 *   - slab (rectangle): 1st click → corner, 2nd click → opposite + place
 *   - slab (polygon): N clicks accumulate; Enter / double-click closes
 *     (keyboard layer / add-element-double-click.ts; this only appends)
 */
async function handleAddElementDrop(
  point: { x: number; y: number; z: number },
  storeyOverride?: { modelId: string; storeyId: number },
): Promise<void> {
  const ctx = resolveAddElementContext(storeyOverride);
  if (!ctx) return;
  const { modelId, storeyId } = ctx;

  const state = useViewerStore.getState();
  const type = state.addElementType;

  // Single-click placements: column / door / window all drop on one click.
  if (type === 'column') {
    const ifc = rendererPointToIfcStoreyLocal(point, modelId);
    const p = state.addElementColumnParams;
    finishAddElement(state.addColumn(modelId, storeyId, {
      Position: ifc, Width: p.Width, Depth: p.Depth, Height: p.Height,
    }), modelId, 'Column');
    return;
  }
  if (type === 'door') {
    const ifc = rendererPointToIfcStoreyLocal(point, modelId);
    const p = state.addElementDoorParams;
    finishAddElement(state.addDoor(modelId, storeyId, {
      Position: ifc, Width: p.Width, Height: p.Height, FrameThickness: p.FrameThickness,
    }), modelId, 'Door');
    return;
  }
  if (type === 'window') {
    const ifc = rendererPointToIfcStoreyLocal(point, modelId);
    const p = state.addElementWindowParams;
    finishAddElement(state.addWindow(modelId, storeyId, {
      Position: ifc, Width: p.Width, Height: p.Height, FrameThickness: p.FrameThickness,
    }), modelId, 'Window');
    return;
  }

  // Walls are drawn by the `wall.place` modeling command (#6232), not here.
  if (type === 'beam' || type === 'member') {
    const pending = state.addElementPendingPoints;
    if (pending.length === 0) {
      // Start point — store the renderer-frame point and wait for end.
      state.appendAddElementPendingPoint({ x: point.x, y: point.y, z: point.z });
      return;
    }
    // End point — convert both points to IFC at dispatch time.
    const startIfc = rendererPointToIfcStoreyLocal(pending[0], modelId);
    const endIfc = rendererPointToIfcStoreyLocal(point, modelId);
    if (type === 'beam') {
      const p = state.addElementBeamParams;
      finishAddElement(state.addBeam(modelId, storeyId, {
        Start: startIfc, End: endIfc, Width: p.Width, Height: p.Height,
      }), modelId, 'Beam');
    } else {
      // member
      const p = state.addElementMemberParams;
      finishAddElement(state.addMember(modelId, storeyId, {
        Start: startIfc, End: endIfc, Width: p.Width, Height: p.Height,
      }), modelId, 'Member');
    }
    return;
  }

  if (type === 'slab' || type === 'roof' || type === 'plate' || type === 'space') {
    if (state.addElementSlabMode === 'rectangle') {
      const pending = state.addElementPendingPoints;
      if (pending.length === 0) {
        state.appendAddElementPendingPoint({ x: point.x, y: point.y, z: point.z });
        return;
      }
      const cornerIfc = rendererPointToIfcStoreyLocal(pending[0], modelId);
      const oppositeIfc = rendererPointToIfcStoreyLocal(point, modelId);
      const minX = Math.min(cornerIfc[0], oppositeIfc[0]);
      const minY = Math.min(cornerIfc[1], oppositeIfc[1]);
      const width = Math.abs(oppositeIfc[0] - cornerIfc[0]);
      const depth = Math.abs(oppositeIfc[1] - cornerIfc[1]);
      if (width <= 0 || depth <= 0) {
        toast.error(`${capitalize(type)} corners must span a non-zero rectangle`);
        return;
      }
      const position: [number, number, number] = [minX, minY, 0];
      switch (type) {
        case 'slab': {
          const p = state.addElementSlabParams;
          finishAddElement(state.addSlab(modelId, storeyId, {
            Position: position, Width: width, Depth: depth, Thickness: p.Thickness,
          }), modelId, 'Slab');
          return;
        }
        case 'roof': {
          const p = state.addElementRoofParams;
          finishAddElement(state.addRoof(modelId, storeyId, {
            Position: position, Width: width, Depth: depth, Thickness: p.Thickness,
          }), modelId, 'Roof');
          return;
        }
        case 'plate': {
          const p = state.addElementPlateParams;
          finishAddElement(state.addPlate(modelId, storeyId, {
            Position: position, Width: width, Depth: depth, Thickness: p.Thickness,
          }), modelId, 'Plate');
          return;
        }
        case 'space': {
          const p = state.addElementSpaceParams;
          finishAddElement(state.addSpace(modelId, storeyId, {
            Position: position, Width: width, Depth: depth, Height: p.Height,
          }), modelId, 'Space');
          return;
        }
      }
    }
    // Polygon mode — append; close handled by Enter.
    state.appendAddElementPendingPoint({ x: point.x, y: point.y, z: point.z });
    return;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Signed 2D polygon area via the shoelace formula. */
function polygonArea2D(points: Array<[number, number]>): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

/**
 * Close an in-progress polygon for any slab-style type
 * (slab / roof / plate / space). Enter or double-click. Requires
 * ≥3 points; the builder's auto-closure handles the trailing edge.
 */
export function commitAddElementSlabPolygon(): void {
  const state = useViewerStore.getState();
  if (state.activeTool !== 'addElement') return;
  const type = state.addElementType;
  const polygonable = type === 'slab' || type === 'roof' || type === 'plate' || type === 'space';
  if (!polygonable || state.addElementSlabMode !== 'polygon') return;
  const pending = state.addElementPendingPoints;
  if (pending.length < 3) {
    toast.error(`${capitalize(type)} polygon needs at least 3 points`);
    return;
  }
  const ctx = resolveAddElementContext();
  if (!ctx) return;
  const { modelId, storeyId } = ctx;
  const outer = pending.map((pt) => {
    const ifc = rendererPointToIfcStoreyLocal(pt, modelId);
    return [ifc[0], ifc[1]] as [number, number];
  });
  // Reject degenerate (zero-area) polygons — repeated or collinear
  // pending points would otherwise produce an OuterCurve that exports
  // as an invalid slab/roof/plate/space profile.
  if (Math.abs(polygonArea2D(outer)) < 1e-6) {
    toast.error(`${capitalize(type)} polygon must have a non-zero area`);
    return;
  }
  switch (type) {
    case 'slab': {
      const p = state.addElementSlabParams;
      finishAddElement(state.addSlab(modelId, storeyId, {
        Profile: 'polygon', OuterCurve: outer, Thickness: p.Thickness,
      }), modelId, 'Slab');
      return;
    }
    case 'roof': {
      const p = state.addElementRoofParams;
      finishAddElement(state.addRoof(modelId, storeyId, {
        Profile: 'polygon', OuterCurve: outer, Thickness: p.Thickness,
      }), modelId, 'Roof');
      return;
    }
    case 'plate': {
      const p = state.addElementPlateParams;
      finishAddElement(state.addPlate(modelId, storeyId, {
        Profile: 'polygon', OuterCurve: outer, Thickness: p.Thickness,
      }), modelId, 'Plate');
      return;
    }
    case 'space': {
      const p = state.addElementSpaceParams;
      finishAddElement(state.addSpace(modelId, storeyId, {
        Profile: 'polygon', OuterCurve: outer, Height: p.Height,
      }), modelId, 'Space');
      return;
    }
  }
}

/**
 * Handle context menu event (right-click).
 * Picks the entity under the cursor and opens the context menu.
 */
export async function handleContextMenu(ctx: MouseHandlerContext, e: MouseEvent): Promise<void> {
  e.preventDefault();
  const { mouseState } = ctx;
  // Right-drag is the fly gesture (see useMouseControls). Some browsers
  // still fire `contextmenu` after a tiny right-drag — skip when the
  // user actually moved, so flying never accidentally pops the menu.
  if (mouseState.didDrag) {
    return;
  }
  await openContextMenuAt(ctx, e.clientX, e.clientY);
}
