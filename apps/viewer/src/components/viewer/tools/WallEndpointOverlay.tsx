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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { rendererPointToIfcStoreyLocal } from '../selectionHandlers';

type Vec2 = { x: number; y: number };
type Vec3 = { x: number; y: number; z: number };
type Project = (worldPos: Vec3) => Vec2 | null;

const HANDLE_RADIUS = 7;
const HANDLE_COLOR = '#a855f7'; // purple-500 — matches edit-mode accent

/**
 * Convert an IFC storey-local point (Z-up, metres) into a renderer
 * world-frame point (Y-up). Mirror of `rendererPointToIfcStoreyLocal`.
 * We don't apply storey elevation here — `readWallEndpoints` returns
 * points in storey-local space (Z = 0 for a planar wall) and the
 * storey's own placement carries the elevation. To project to screen
 * we ride on top of the entity bbox path: bbox center already in
 * renderer frame is what selectionHandlers uses; for the endpoints
 * we add the storey elevation explicitly.
 */
function ifcStoreyLocalToRenderer(p: [number, number, number], storeyElevation: number): Vec3 {
  // IFC Z-up storey-local → renderer Y-up world:
  //   renderer.x =  ifc.x
  //   renderer.y =  ifc.z + storeyElevation
  //   renderer.z = -ifc.y
  return { x: p[0], y: p[2] + storeyElevation, z: -p[1] };
}

interface ActiveDrag {
  end: 'start' | 'end';
  /** Cached counterpart endpoint that stays fixed during the drag. */
  fixedIfc: [number, number, number];
  storeyElevation: number;
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

  const [frameTick, setFrameTick] = useState(0);
  const lastViewpointRef = useRef<string>('');
  const rafRef = useRef<number | null>(null);
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
    // mutationVersion + frameTick force re-resolution after any edit
    // or camera move so handles track live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editEnabled,
    activeTool,
    selectedEntity,
    models,
    readWallEndpoints,
    mutationVersion,
    frameTick,
  ]);

  // RAF tick — same camera-tracking trick as the gizmo. Skipped when
  // the overlay isn't visible.
  useEffect(() => {
    if (!endpoints) return;
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      const vp = getViewpoint?.();
      if (vp) {
        // projectionMode + orthoSize matter for ortho-zoom-only
        // moves that leave position / target / fov untouched — see
        // the matching note in GizmoOverlay.
        const sig = `${vp.position.x},${vp.position.y},${vp.position.z},${vp.target.x},${vp.target.y},${vp.target.z},${vp.fov},${vp.projectionMode},${vp.orthoSize ?? ''}`;
        if (sig !== lastViewpointRef.current) {
          lastViewpointRef.current = sig;
          setFrameTick((n) => (n + 1) % 1_000_000);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [endpoints, getViewpoint]);

  if (!endpoints || !projectToScreen) return null;
  const project = projectToScreen as Project;

  const startWorld = ifcStoreyLocalToRenderer(endpoints.start, endpoints.storeyElevation);
  const endWorld = ifcStoreyLocalToRenderer(endpoints.end, endpoints.storeyElevation);
  const startScreen = project(startWorld);
  const endScreen = project(endWorld);
  if (!startScreen || !endScreen) return null;

  const startDrag = (which: 'start' | 'end', e: React.PointerEvent<SVGElement>) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as SVGElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      end: which,
      fixedIfc: which === 'start' ? endpoints.end : endpoints.start,
      storeyElevation: endpoints.storeyElevation,
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
    const world = pickFn(clientX, clientY, drag.storeyElevation);
    if (!world) return null;
    return rendererPointToIfcStoreyLocal(world);
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

