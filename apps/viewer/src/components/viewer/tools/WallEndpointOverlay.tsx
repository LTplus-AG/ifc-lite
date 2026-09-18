/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Endpoint drag handles for a selected rectangular-profile wall.
 * Renders two SVG circles at the wall's storey-floor start and end
 * points; dragging either projects the cursor back onto the storey
 * floor plane and commits a `resizeWall` mutation in IFC frame.
 *
 * Gating:
 *   - `editEnabled` is on
 *   - `activeTool === 'select'`
 *   - selected entity is a wall (`IfcWall`) with a resolvable wall
 *     edit chain — `readWallEndpoints` returning non-null is the gate
 *
 * Source-buffer walls (loaded from a parsed IFC, not added via
 * `addWallToStore`) may or may not have the rectangle-profile shape
 * the resize action expects. The handles surface only when the chain
 * resolves, so the user never grabs a handle that can't commit.
 *
 * Drag math:
 *   The two endpoints live in IFC storey-local (Z-up) space. The
 *   renderer is Y-up. To project cursor → world point on the storey
 *   floor, we use the renderer's existing `raycastStoreyFloor`
 *   helper (re-exported via `selectionHandlers`) — same fallback used
 *   by the wall draw tool, so snapping and floor-plane semantics
 *   match. Result is in renderer frame; we convert to IFC via
 *   `rendererPointToIfcStoreyLocal`.
 *
 * We commit one `resizeWall` call per pointer-move frame. The action
 * pushes four positional mutations onto the undo stack (start, dir,
 * profile length, profile origin) so each drag frame is a coarse but
 * recoverable step. Future polish: a batched-mutation primitive that
 * folds the four into one undo entry.
 */

import { useMemo, useRef } from 'react';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { useCameraTickSubscription } from '@/hooks/useCameraTickSubscription';
import { rendererPointToIfcStoreyLocal } from '../selectionHandlers';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state.js';
import { modelPointToWorkspacePoint } from '@/lib/model-placement/rotation.js';
import { toRenderTranslation, type Translation } from '@/lib/model-placement/translation.js';

type Vec2 = { x: number; y: number };
type Vec3 = { x: number; y: number; z: number };
type Project = (worldPos: Vec3) => Vec2 | null;

const HANDLE_RADIUS = 7;
const HANDLE_COLOR = '#a855f7'; // purple-500 — matches edit-mode accent

/**
 * Convert an IFC storey-local point (Z-up, metres) into a renderer
 * world-frame point (Y-up). Mirror of `rendererPointToIfcStoreyLocal`,
 * including its #4932 placement handling: `readWallEndpoints` returns
 * points in the WALL's model frame (storey-local, Z = 0 for a planar
 * wall; we add the storey elevation explicitly since it isn't carried
 * per-point), and forward through `modelId`'s reposition placement
 * (heading about the pivot, then translation) before the axis swap, so
 * a wall on a moved or rotated model draws its resize handles ON the
 * wall rather than at its un-repositioned position.
 */
function ifcStoreyLocalToRenderer(p: [number, number, number], storeyElevation: number, modelId: string): Vec3 {
  const modelPoint: Translation = [p[0], p[1], p[2] + storeyElevation];
  const [x, y, z] = toRenderTranslation(modelPointToWorkspacePoint(modelPoint, placementOf(modelId)));
  return { x, y, z };
}

/** `modelId`'s current displayed placement (translation, including an
 * in-flight move-preview drag; committed heading — rotation has no
 * preview stage). Shared by the draw transform above and the drag
 * floor-plane height below so the two directions cannot drift apart. */
function placementOf(modelId: string): { translation: Translation; rotation: ReturnType<typeof placementFor>['rotation'] } {
  const state = useViewerStore.getState();
  return { translation: displayedTranslation(state.modelPlacement, modelId),
    rotation: placementFor(state.modelPlacement, modelId).rotation };
}

interface ActiveDrag {
  end: 'start' | 'end';
  /** Cached counterpart endpoint that stays fixed during the drag. */
  fixedIfc: [number, number, number];
  /**
   * Renderer-frame Y of the floor plane the drag unprojects onto — the
   * model's storey elevation PLUS its placement's vertical translation
   * (#4932 follow-up), so this matches the height `ifcStoreyLocalToRenderer`
   * already draws the handles at. Left at the raw, un-placed elevation, a
   * model moved vertically would have its handles rendered at the correct
   * (placed) height but its drag plane at the wrong one — under a
   * non-top-down camera the two disagree, and the raycast lands somewhere
   * other than under the cursor before `rendererPointToIfcStoreyLocal`
   * (correctly) inverts the placement on whatever it found.
   */
  planeRenderY: number;
}

export function WallEndpointOverlay() {
  const editEnabled = useViewerStore((s) => s.editEnabled);
  const activeTool = useViewerStore((s) => s.activeTool);
  const selectedEntity = useViewerStore((s) => s.selectedEntity);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const getViewpoint = useViewerStore((s) => s.cameraCallbacks.getViewpoint);
  const readWallEndpoints = useViewerStore((s) => s.readWallEndpoints);
  const resizeWall = useViewerStore((s) => s.resizeWall);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const { models } = useIfc();
  // Subscribed for the re-render alone, same idiom as `useCameraTickSubscription`
  // below: `startWorld`/`endWorld`/`startScreen`/`endScreen` are computed fresh
  // in the render body on every render, not memoized, so nothing here reads
  // the value. What was missing (Macroscope review on #4953) is a REASON to
  // re-render at all when a model is repositioned while a wall is selected:
  // none of the other subscriptions above (`editEnabled`, `activeTool`,
  // `selectedEntity`, `mutationVersion`, ...) change on a reposition, so
  // without this the handles stayed at their last-rendered screen position
  // until some UNRELATED update happened to re-render the component, even
  // though the wall itself (driven by `useModelPlacementSync`, a separate
  // subscription) moved immediately.
  useViewerStore((s) => s.modelPlacement);

  const dragRef = useRef<ActiveDrag | null>(null);

  // Discover the wall's endpoints + storey elevation. Re-resolves on
  // every mutation so any other mutation (translate, rotate) updates
  // the handles. Returns null when the entity isn't a resizable wall.
  const endpoints = useMemo(() => {
    if (!editEnabled || activeTool !== 'select') return null;
    if (!selectedEntity) return null;
    const wall = readWallEndpoints(selectedEntity.modelId, selectedEntity.expressId);
    if (!wall) return null;
    // Storey elevation — needed to project endpoints back into renderer
    // world. Pulled from the model's spatial hierarchy so multi-model
    // sessions stay correct.
    const model = models.get(selectedEntity.modelId);
    const dataStore = model?.ifcDataStore;
    const hierarchy = dataStore?.spatialHierarchy;
    const storeyId = hierarchy?.elementToStorey.get(selectedEntity.expressId);
    const storeyElevation =
      (storeyId !== undefined ? hierarchy?.storeyElevations?.get(storeyId) : undefined) ?? 0;
    return {
      modelId: selectedEntity.modelId,
      expressId: selectedEntity.expressId,
      start: wall.start,
      end: wall.end,
      storeyElevation,
    };
    // mutationVersion forces re-resolution after any edit so handles
    // track live. Camera moves don't change endpoints — the
    // `useCameraTickSubscription` below re-renders the host so the
    // JSX projection refreshes without re-running this memo.
  }, [
    editEnabled,
    activeTool,
    selectedEntity,
    models,
    readWallEndpoints,
    mutationVersion,
  ]);

  // Camera-tick subscription — wakes the overlay on real viewpoint
  // motion so the projection stays aligned. Skipped when the overlay
  // isn't visible.
  void useCameraTickSubscription(getViewpoint, endpoints !== null);

  if (!endpoints || !projectToScreen) return null;
  const project = projectToScreen as Project;

  const startWorld = ifcStoreyLocalToRenderer(endpoints.start, endpoints.storeyElevation, endpoints.modelId);
  const endWorld = ifcStoreyLocalToRenderer(endpoints.end, endpoints.storeyElevation, endpoints.modelId);
  const startScreen = project(startWorld);
  const endScreen = project(endWorld);
  if (!startScreen || !endScreen) return null;

  const startDrag = (which: 'start' | 'end', e: React.PointerEvent<SVGElement>) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as SVGElement).setPointerCapture(e.pointerId);
    // A yaw about the vertical axis never touches elevation, so only the
    // translation's Z applies — no need to round-trip through the full
    // rotate-then-translate transform for a single scalar.
    dragRef.current = {
      end: which,
      fixedIfc: which === 'start' ? endpoints.end : endpoints.start,
      planeRenderY: endpoints.storeyElevation + placementOf(endpoints.modelId).translation[2],
    };
  };

  /**
   * Unproject the cursor onto the storey floor plane and return the
   * resulting point in IFC storey-local space. Uses the camera's
   * `unprojectToFloor` callback (added in this PR) — same machinery
   * as the addElement tool's floor-fallback, so behaviour matches.
   */
  const screenToFloorIfc = (clientX: number, clientY: number): [number, number, number] | null => {
    const drag = dragRef.current;
    if (!drag) return null;
    const pickFn = useViewerStore.getState().cameraCallbacks.unprojectToFloor;
    if (typeof pickFn !== 'function') return null;
    const world = pickFn(clientX, clientY, drag.planeRenderY);
    if (!world) return null;
    return rendererPointToIfcStoreyLocal(world, endpoints.modelId);
  };

  const onDragMove = (e: React.PointerEvent<SVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const ifc = screenToFloorIfc(e.clientX, e.clientY);
    if (!ifc) return;
    const newStart = drag.end === 'start' ? ifc : drag.fixedIfc;
    const newEnd = drag.end === 'end' ? ifc : drag.fixedIfc;
    const result = resizeWall(endpoints.modelId, endpoints.expressId, newStart, newEnd);
    if (!result.ok) {
      // Most likely a zero-length drag (cursor over the fixed end).
      // Don't toast every frame; just skip the write.
      return;
    }
  };

  const onDragEnd = (e: React.PointerEvent<SVGElement>) => {
    if (!dragRef.current) return;
    try {
      (e.target as SVGElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released — safe to ignore */
    }
    dragRef.current = null;
  };

  // Validate that the unproject callback exists once per render —
  // if it doesn't, the handles are inert. Render them as a hint that
  // the wall IS resizable; just warn the user once.
  const hasUnproject =
    typeof useViewerStore.getState().cameraCallbacks.unprojectToFloor === 'function';
  if (!hasUnproject) {
    // Quietly skip — no need to spam toast on every render. The
    // numeric Move controls in GeometryEditCard still work.
    return null;
  }

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-30"
      style={{ overflow: 'visible' }}
    >
      {/* Dashed axis line connecting the two handles — visual cue
          that they belong to one wall and orient its sweep. */}
      <line
        x1={startScreen.x}
        y1={startScreen.y}
        x2={endScreen.x}
        y2={endScreen.y}
        stroke={HANDLE_COLOR}
        strokeWidth={1.5}
        strokeDasharray="4 4"
        opacity={0.5}
      />
      {[
        { which: 'start' as const, screen: startScreen },
        { which: 'end' as const, screen: endScreen },
      ].map(({ which, screen }) => (
        <g key={which} style={{ pointerEvents: 'auto' }}>
          {/* Generous hit area so users don't have to land pixel-perfect. */}
          <circle
            cx={screen.x}
            cy={screen.y}
            r={HANDLE_RADIUS + 6}
            fill="transparent"
            style={{ cursor: 'grab' }}
            onPointerDown={(e) => startDrag(which, e)}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
          />
          {/* Visible handle. */}
          <circle
            cx={screen.x}
            cy={screen.y}
            r={HANDLE_RADIUS}
            fill="#fff"
            stroke={HANDLE_COLOR}
            strokeWidth={2.5}
            pointerEvents="none"
          />
        </g>
      ))}
    </svg>
  );
}

