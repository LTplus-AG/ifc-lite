/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Move gizmo for the selected entity. Renders three SVG axis arrows
 * (X red, Y green, Z blue — IFC Z-up convention) anchored to the
 * entity's bounding-box center. Dragging an arrow translates the
 * entity along that axis via `MutationSlice.translateEntity`.
 *
 * Render conditions:
 *   - `editEnabled` is on
 *   - `activeTool === 'select'` (so the gizmo doesn't fight measure /
 *     section / addElement)
 *   - exactly one entity is selected
 *   - the selection has a placement chain that can be translated
 *     (`resolvePlacementChain` returns non-null)
 *
 * Coordinate spaces:
 *   The renderer is Y-up. IFC is Z-up. We project two world points
 *   per axis (origin and origin + 1m in the chosen direction in
 *   renderer frame) to screen. The screen-space vector between them
 *   IS our "1 metre" delta projection — so the per-frame drag math
 *   reduces to a single dot product against the cursor's screen
 *   delta. No camera matrix inversion required; we lean entirely on
 *   the existing `projectToScreen` callback.
 *
 * The drag commits a single `translateEntity` call per frame (no
 * batching). Each call lands as one mutation on the undo stack,
 * which is intentionally coarse — fine for v1; if it gets noisy we
 * can collapse runs in a later pass.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { getEntityCenter } from '@/utils/viewportUtils';

type Vec2 = { x: number; y: number };
type Vec3 = { x: number; y: number; z: number };
type Project = (worldPos: Vec3) => Vec2 | null;
type Axis = 'x' | 'y' | 'z';

const AXIS_COLORS: Record<Axis, string> = {
  x: '#ef4444', // red — IFC X
  y: '#10b981', // green — IFC Y
  z: '#3b82f6', // blue — IFC Z (up)
};

/** Renderer-frame unit vector for each IFC axis. */
const AXIS_RENDERER_OFFSET: Record<Axis, Vec3> = {
  // IFC +X = renderer +X
  x: { x: 1, y: 0, z: 0 },
  // IFC +Y = renderer -Z (renderer Z is forward; IFC Y is plan-forward)
  y: { x: 0, y: 0, z: -1 },
  // IFC +Z = renderer +Y (Z-up vs Y-up)
  z: { x: 0, y: 1, z: 0 },
};

function pickViewerOrigin(meshes: import('@ifc-lite/geometry').MeshData[] | null, globalId: number): Vec3 | null {
  return getEntityCenter(meshes ?? null, globalId);
}

export function GizmoOverlay() {
  const editEnabled = useViewerStore((s) => s.editEnabled);
  const activeTool = useViewerStore((s) => s.activeTool);
  const selectedEntity = useViewerStore((s) => s.selectedEntity);
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const getViewpoint = useViewerStore((s) => s.cameraCallbacks.getViewpoint);
  const translateEntity = useViewerStore((s) => s.translateEntity);
  const readEntityPosition = useViewerStore((s) => s.readEntityPosition);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const { models, geometryResult } = useIfc();

  // Force a re-render on camera moves so the gizmo tracks the
  // viewport (the camera tick bypasses React renders for perf — see
  // `Viewport.tsx` `updateCameraRotationRealtime`). Same RAF pattern
  // as AddElementOverlay, gated on actual viewpoint deltas.
  const [frameTick, setFrameTick] = useState(0);
  const lastViewpointRef = useRef<string>('');
  const rafRef = useRef<number | null>(null);

  // Drag state — refs instead of state to avoid re-render thrashing.
  const dragRef = useRef<{
    axis: Axis;
    originScreen: Vec2;
    axisScreenPerMeter: Vec2; // dx/dy in pixels for a +1m world move
    accumulatedDelta: Vec3; // IFC-frame delta applied so far this drag
    cursorStart: Vec2;
  } | null>(null);

  // Decide whether the gizmo is renderable at all this frame. The
  // movability gate is `readEntityPosition` (slice action that
  // lazily creates the StoreEditor) so the arrows surface on the
  // user's first selection — no need to wait for an unrelated
  // mutation to prime the editor cache.
  const ready = useMemo(() => {
    if (!editEnabled) return null;
    if (activeTool !== 'select') return null;
    if (!selectedEntity || selectedEntityId === null) return null;
    if (!projectToScreen) return null;

    const model = models.get(selectedEntity.modelId);
    if (!model?.ifcDataStore) return null;

    const coords = readEntityPosition(selectedEntity.modelId, selectedEntity.expressId);
    if (!coords) return null;

    // Origin in renderer frame — bbox center of the entity's meshes.
    const meshes = (model.geometryResult ?? geometryResult)?.meshes ?? null;
    const origin = pickViewerOrigin(meshes, selectedEntityId);
    if (!origin) return null;
    return { origin, modelId: selectedEntity.modelId, expressId: selectedEntity.expressId };
    // mutationVersion is a dep so the origin re-resolves after edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editEnabled,
    activeTool,
    selectedEntity,
    selectedEntityId,
    models,
    geometryResult,
    projectToScreen,
    readEntityPosition,
    mutationVersion,
    frameTick,
  ]);

  // RAF loop — tracks the camera so screen-space coords stay aligned.
  useEffect(() => {
    if (!ready) return;
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      const vp = getViewpoint?.();
      if (vp) {
        // Include projectionMode + orthoSize so ortho-zoom-only
        // changes (which leave position / target / fov untouched)
        // still wake the overlay. Without these the gizmo lags
        // ortho zoom; the perspective path was already covered by
        // fov in the signature.
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
  }, [ready, getViewpoint]);

  if (!ready) return null;

  const project = projectToScreen as Project;
  const originScreen = project(ready.origin);
  if (!originScreen) return null;

  // Axis tip screen positions. Length is fixed at 0.75m world units
  // — short enough not to overwhelm a small element, long enough to
  // be grab-friendly on a large one. We do NOT scale by camera
  // distance because projectToScreen already does perspective foreshortening.
  const ARROW_WORLD_LENGTH = 0.75;

  const axisTips: Partial<Record<Axis, Vec2>> = {};
  const axisPerMeter: Partial<Record<Axis, Vec2>> = {};
  for (const axis of ['x', 'y', 'z'] as const) {
    const off = AXIS_RENDERER_OFFSET[axis];
    const tipWorld: Vec3 = {
      x: ready.origin.x + off.x * ARROW_WORLD_LENGTH,
      y: ready.origin.y + off.y * ARROW_WORLD_LENGTH,
      z: ready.origin.z + off.z * ARROW_WORLD_LENGTH,
    };
    const tipScreen = project(tipWorld);
    if (!tipScreen) continue;
    axisTips[axis] = tipScreen;
    axisPerMeter[axis] = {
      x: (tipScreen.x - originScreen.x) / ARROW_WORLD_LENGTH,
      y: (tipScreen.y - originScreen.y) / ARROW_WORLD_LENGTH,
    };
  }

  const startDrag = (axis: Axis, e: React.PointerEvent<SVGElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const perMetre = axisPerMeter[axis];
    if (!perMetre) return;
    (e.target as SVGElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      axis,
      originScreen,
      axisScreenPerMeter: perMetre,
      accumulatedDelta: { x: 0, y: 0, z: 0 },
      cursorStart: { x: e.clientX, y: e.clientY },
    };
  };

  const onDragMove = (e: React.PointerEvent<SVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const cursorDelta: Vec2 = {
      x: e.clientX - drag.cursorStart.x,
      y: e.clientY - drag.cursorStart.y,
    };
    // Scalar projection of the cursor delta onto the on-screen axis
    // direction. |axisScreenPerMeter|^2 is the squared pixel length
    // of a 1m world segment along this axis — dividing by it converts
    // pixels back into metres.
    const ax = drag.axisScreenPerMeter;
    const denom = ax.x * ax.x + ax.y * ax.y;
    if (denom < 1e-6) return;
    const metres = (cursorDelta.x * ax.x + cursorDelta.y * ax.y) / denom;
    // Delta since the LAST frame of this drag.
    const previous = drag.accumulatedDelta;
    const delta: [number, number, number] = [0, 0, 0];
    const idx = drag.axis === 'x' ? 0 : drag.axis === 'y' ? 1 : 2;
    delta[idx] = metres - (drag.axis === 'x' ? previous.x : drag.axis === 'y' ? previous.y : previous.z);
    if (Math.abs(delta[idx]) < 1e-6) return;
    // Only advance the per-axis accumulator if the mutation actually
    // landed. If `translateEntity` rejects (placement chain doesn't
    // resolve, missing data store, etc.) the model state didn't
    // change, so leaving the accumulator at its previous value means
    // the next pointer-move frame retries the full delta instead of
    // silently dropping it. Keeps drag state and model state in sync.
    const result = translateEntity(ready.modelId, ready.expressId, delta);
    if (!result.ok) return;
    if (drag.axis === 'x') previous.x = metres;
    else if (drag.axis === 'y') previous.y = metres;
    else previous.z = metres;
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

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-30"
      style={{ overflow: 'visible' }}
    >
      <defs>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <marker
            key={axis}
            id={`gizmo-arrow-${axis}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={AXIS_COLORS[axis]} />
          </marker>
        ))}
      </defs>

      {/* Outer hit area (transparent, wider) on top of each visible arrow
          so the user can grab without pixel precision. Pointer events
          on the SVG itself are off — the per-handle layer turns them
          back on. */}
      {(['x', 'y', 'z'] as const).map((axis) => {
        const tip = axisTips[axis];
        if (!tip) return null;
        const colour = AXIS_COLORS[axis];
        return (
          <g key={axis} style={{ pointerEvents: 'auto' }}>
            <line
              x1={originScreen.x}
              y1={originScreen.y}
              x2={tip.x}
              y2={tip.y}
              stroke="transparent"
              strokeWidth={14}
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => startDrag(axis, e)}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onPointerCancel={onDragEnd}
            />
            <line
              x1={originScreen.x}
              y1={originScreen.y}
              x2={tip.x}
              y2={tip.y}
              stroke={colour}
              strokeWidth={3}
              strokeLinecap="round"
              markerEnd={`url(#gizmo-arrow-${axis})`}
              pointerEvents="none"
            />
          </g>
        );
      })}

      {/* Origin handle — small dot that hints "this is what you're moving". */}
      <circle
        cx={originScreen.x}
        cy={originScreen.y}
        r={4}
        fill="#fff"
        stroke="#71717a"
        strokeWidth={1.5}
        pointerEvents="none"
      />
    </svg>
  );
}
