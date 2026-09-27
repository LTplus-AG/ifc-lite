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
import { fromGlobalIdFromModels } from '@/store/globalId';
import { pointInPolygon } from '@/lib/polygon-clip';
import { toast } from '@/components/ui/toast';
import { notifyElementSplit, notifySplitFailed, notifyWallSplit } from './wallSplitNotice.js';
import { pickToSplitLocal, splitAxisToRendererConvention, splitLocalToRenderer } from './split-frame.js';
import { raycastForPolylinePoint, isNearPolylineStart,
  isDuplicateClickPoint,
} from './measureHandlers.js';
import { pickViewportAppearanceFace, viewportFacePickError } from './appearance/face-mask/viewport-face-picker.js';
import { displayedTranslation } from '@/lib/model-placement/state.js';
import { resolve as translate } from '@/i18n/registry';
import { raycastFloorPlane, storeyFloorY } from './pick-frame.js';
import { resolveWorkplaneStorey } from './add-element-workplane.js';
import { handleAddElementClick } from './add-element-handlers.js';
import { shortcutLabel } from '@/lib/commands/shortcut-label';

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

  // Add-element tool — multi-click placement (start→end for walls/beams,
  // corner→opposite for slab rectangle, N+Enter for slab polygon, single
  // for columns). Uses magnetic snap so points lock to vertices/edges
  // when the cursor is near them — same UX as the measure tool.
  // Split tool — click on a wall / beam / column / member to cut
  // it at the cursor's projected position. Hover preview lives on
  // the store (splitHoverPoint / splitHoverDistance) and
  // SplitOverlay renders the SVG guide; this handler commits the
  // click by dispatching to the right action for the latched
  // target's element type.
  if (tool === 'split') {
    const state = useViewerStore.getState();
    const targetModelId = state.splitTargetModelId;
    const targetExpressId = state.splitTargetExpressId;
    if (targetModelId === null || targetExpressId === null) {
      // Click missed any splittable element — no-op so the cursor
      // doesn't fight the user. The overlay's hint stays visible.
      return;
    }
    // The Split button's own predicate picks the commit path (#6233), so a
    // refusal here names the same reason the button's tooltip does.
    const target = state.readSplitTarget(targetModelId, targetExpressId);
    if (!target.ok) {
      notifySplitFailed(translate(target.reasonKey));
      return;
    }

    if (target.kind !== 'slab') {
      // Single-click element split (wall / beam / column / member) at the
      // hover preview's projected distance; no preview yet → nothing to cut.
      const distance = state.splitHoverDistance;
      if (distance === null) return;
      const result = target.kind === 'wall'
        ? state.splitWallAtDistance(targetModelId, targetExpressId, distance)
        : state.splitLinearElementAtDistance(targetModelId, targetExpressId, distance);
      if (!result.ok) {
        notifySplitFailed(translate('splitTool.failed', { reason: result.reason }));
        return;
      }
      state.clearSplitHover();
      state.setSelectedEntityId(result.right.globalId);
      // Both wall-split commit paths — here and the Split tool's typed
      // distance — announce through the same emitter (`wallSplitNotice.ts`).
      if ('openings' in result) notifyWallSplit(result.openings);
      else notifyElementSplit();
      return;
    }

    // Slab two-click flow. The second click commits the cut line from the
    // latched anchor → cursor, raycast onto the SOURCE SLAB'S floor (not the
    // global active storey) so federated / non-active-storey splits land at
    // the right elevation.
    if (state.splitMode === 'first-anchor' && state.slabCutAnchor) {
      const slabFloorY = resolveSlabFloorY(targetModelId, targetExpressId);
      const cutPoint = raycastStoreyFloor(ctx, x, y, slabFloorY ?? undefined);
      if (!cutPoint) {
        notifySplitFailed("Couldn't read cut point");
        return;
      }
      const cursorIfc = pickToSplitLocal(cutPoint, targetModelId, targetExpressId);
      if (!cursorIfc) return;
      const result = state.splitSlabByLine(
        targetModelId,
        targetExpressId,
        state.slabCutAnchor,
        [cursorIfc[0], cursorIfc[1]],
      );
      if (!result.ok) {
        notifySplitFailed(translate('splitTool.failed', { reason: result.reason }));
        return;
      }
      state.clearSplitHover();
      // Move selection to whichever half contains the click. Both
      // halves are valid polygons; the click landed at `cursorIfc`.
      const rightFp = state.readSlabFootprint(targetModelId, result.right.expressId);
      const inRight = rightFp
        ? pointInPolygon(rightFp.footprint, [cursorIfc[0], cursorIfc[1]])
        : false;
      state.setSelectedEntityId(inRight ? result.right.globalId : result.left.globalId);
      toast.success(`Slab split — ${shortcutLabel('edit.undo')} to undo`);
      return;
    }

    // First click latches the anchor on the source slab's storey floor (not
    // the global active storey). The RAYCAST plane is placement-aware
    // (#4932 follow-up), the same `resolveSlabFloorY` the second click uses,
    // so both clicks raycast the same height on a vertically repositioned
    // slab under an oblique camera; `resolveSlabFloorY` reads the same
    // elevation `slabFootprint.storeyElevation` does, made symmetric.
    const slabFootprint = state.readSlabFootprint(targetModelId, targetExpressId);
    if (!slabFootprint) return;
    const anchorPlaneY = resolveSlabFloorY(targetModelId, targetExpressId) ?? slabFootprint.storeyElevation;
    const anchorPoint = raycastStoreyFloor(ctx, x, y, anchorPlaneY);
    if (!anchorPoint) {
      notifySplitFailed("Couldn't read anchor point");
      return;
    }
    const anchorIfc = pickToSplitLocal(anchorPoint, targetModelId, targetExpressId);
    if (!anchorIfc) return;
    state.setSlabCutAnchor(
      [anchorIfc[0], anchorIfc[1]],
      slabFootprint.footprint,
      slabFootprint.storeyElevation,
    );
    return;
  }

  if (tool === 'addElement') {
    handleAddElementClick(ctx, x, y);
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
 * Storey-floor ray-plane intersection — used as a fallback when the
 * scene raycast misses every mesh (so the user can place new elements
 * in empty space, not just on existing surfaces). The floor sits at
 * renderer Y = storey elevation.
 *
 * `storeyOverride` lets the caller supply an explicit floor Y
 * (renderer frame). Used by the Split tool so a slab on storey 3
 * doesn't accidentally project clicks onto storey 0's floor when
 * the addElement / active-model state points elsewhere. Falls back
 * to `resolveStoreyFloorY()` (active-model lookup) when omitted.
 */
function raycastStoreyFloor(
  ctx: MouseHandlerContext,
  x: number,
  y: number,
  storeyOverride?: number,
): { x: number; y: number; z: number } | null {
  return raycastFloorPlane(ctx, x, y, storeyOverride ?? panelStoreyFloorY());
}

/**
 * Helper: resolve a slab's storey elevation in renderer-frame Y so
 * callers can pass it to `raycastStoreyFloor`. Read from the
 * model's spatialHierarchy (matches the rest of the split flow's
 * elevation lookups), offset by the model's own vertical reposition
 * (#4932) — a model moved up or down renders its floor there too, and
 * the fallback plane this drives has to agree with what's on screen.
 * Rotation is a yaw and never tilts the floor, so only the
 * translation's Z applies. Returns null when the slab isn't contained
 * in a storey we can resolve.
 */
function resolveSlabFloorY(modelId: string, expressId: number): number | null {
  const state = useViewerStore.getState();
  const ds = state.models.get(modelId)?.ifcDataStore;
  if (!ds) return null;
  const storeyId = ds.spatialHierarchy?.elementToStorey.get(expressId);
  if (storeyId === undefined) return null;
  const elev = ds.spatialHierarchy?.storeyElevations?.get(storeyId);
  return typeof elev === 'number' ? elev + displayedTranslation(state.modelPlacement, modelId)[2] : null;
}

/**
 * Renderer Y of the Add Element panel's storey floor (the first available
 * storey when none is picked), offset by the model's own vertical reposition
 * (#4932). Falls back to 0 when nothing is loaded.
 */
function panelStoreyFloorY(): number {
  const ref = resolveWorkplaneStorey(null);
  return typeof ref === 'string' ? 0 : storeyFloorY(ref.modelId, ref.storeyId) ?? 0;
}

/**
 * Live hover preview for the Split tool. SCOPED TO THE CURRENT
 * SPLIT TARGET — the slice's `splitTargetModelId` /
 * `splitTargetExpressId` are set when the user enters Split mode
 * (via Geometry-card Split button or K shortcut), and they never
 * change as the cursor moves over other elements. Hovering over a
 * different wall does NOT switch target; the user must exit Split
 * (Esc), re-select, and re-enter.
 *
 * This is the v2 model — the previous "free-roam, hover anything,
 * latch new target each frame" approach surfaced way too many
 * actionable elements at once and made it unclear what would be
 * cut. Selection-bound matches the rest of the edit-mode UX
 * (gizmo, geometry card, etc.).
 *
 * The cursor still drives the cut POINT — we ray-cast to get a
 * world point, project that onto the target's axis (linear) or
 * use cursor XY (slab), and push the result into the slice for
 * the SplitOverlay to render.
 */
export function handleSplitHover(ctx: MouseHandlerContext, x: number, y: number): boolean {
  const { renderer } = ctx;
  if (!ctx.measureRaycastPendingRef.current) {
    ctx.measureRaycastPendingRef.current = true;
    ctx.measureRaycastFrameRef.current = requestAnimationFrame(() => {
      ctx.measureRaycastPendingRef.current = false;
      ctx.measureRaycastFrameRef.current = null;

      const store = useViewerStore.getState();
      const targetModelId = store.splitTargetModelId;
      const targetExpressId = store.splitTargetExpressId;
      if (targetModelId === null || targetExpressId === null) {
        // Split engaged with no target — clear any stale hover.
        if (store.splitMode === 'aiming') store.clearSplitHover();
        return;
      }

      // Ray-cast to get a world point under the cursor. We don't
      // care which entity it hit — we use the world point and
      // project it onto the TARGET's axis. Falls back to the
      // storey floor so the user can aim at empty space and still
      // get a sensible cut.
      const result = renderer.raycastScene(x, y, {
        hiddenIds: ctx.hiddenEntitiesRef.current,
        isolatedIds: ctx.isolatedEntitiesRef.current,
      });
      // Fallback raycast uses the TARGET's storey floor (not the
      // global active storey) so the cursor projection stays in
      // the same Y plane as the element being split.
      const targetFloorY = resolveSlabFloorY(targetModelId, targetExpressId) ?? undefined;
      const worldPoint = result?.intersection?.point
        ?? raycastStoreyFloor(ctx, x, y, targetFloorY);
      if (!worldPoint) {
        if (store.splitMode === 'aiming') store.clearSplitHover();
        return;
      }
      // Storey-local, like every split chain (`split-frame.ts`, #6233); Z is
      // the height above the floor, which a column's vertical axis needs.
      const cursorLocal = pickToSplitLocal(worldPoint, targetModelId, targetExpressId);
      if (!cursorLocal) {
        if (store.splitMode === 'aiming') store.clearSplitHover();
        return;
      }
      const [cx, cy] = cursorLocal;

      // Project onto the target. Try wall (1D), then linear (1D),
      // then slab (2D — uses the cursor XY directly as a candidate
      // cut endpoint).
      const projection =
        store.readWallSplitProjection(targetModelId, targetExpressId, [cx, cy, 0]) ??
        store.readLinearElementSplitProjection(targetModelId, targetExpressId, cursorLocal);
      if (projection) {
        // Forward through the storey frame and the model's placement (#4932)
        // so the ghost cut line lands where the commit will cut.
        const cutRendererFrame = splitLocalToRenderer(projection.cutPoint, targetModelId, targetExpressId);
        const axis = splitAxisToRendererConvention(projection.cutPoint, projection.axis, targetModelId, targetExpressId);
        if (!cutRendererFrame) return;
        store.setSplitHover(cutRendererFrame, projection.distance, projection.length, projection.cutPoint, axis);
        return;
      }
      // Slab path — the overlay outlines the polygon + ghost cut
      // line; the cursor's storey-local XY is the candidate endpoint.
      if (store.readSlabFootprint(targetModelId, targetExpressId)) {
        const cursorRendererFrame = splitLocalToRenderer([cx, cy, 0], targetModelId, targetExpressId);
        if (cursorRendererFrame) store.setSplitHover(cursorRendererFrame, 0, 0, [cx, cy, 0], null);
        return;
      }
      // Target isn't a splittable shape (rare — gets latched by
      // the K shortcut / Split button which already checks). Clear.
      if (store.splitMode === 'aiming') store.clearSplitHover();
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
