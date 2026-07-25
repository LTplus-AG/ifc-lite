/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3D display + interactive editing for location zones (issue #1810 v1).
 *
 * Follows the SAME hand-rolled SVG-overlay technique as `GizmoOverlay.tsx`
 * (the renderer has no react-three-fiber/drei — see that file's header):
 * `projectToScreen` turns world points into screen pixels, and per-axis drag
 * math reduces to a dot product against the cursor's screen delta because a
 * probe at +1 world unit gives "screen pixels per metre" directly.
 *
 * Picking contract: the root `<svg>` is `pointer-events: none` always (so
 * zone boxes never intercept clicks on model elements). Only the currently
 * `editingZone`'s handles turn pointer-events back on for themselves — every
 * other zone box (and this one outside of edit mode) is decorative only.
 */

import { useMemo, useRef } from 'react';
import { useViewerStore } from '@/store';
import { useCameraTickSubscription } from '@/hooks/useCameraTickSubscription';
import { useZoneAssignmentSync } from '@/hooks/useZoneAssignmentSync';
import { zoneColorForIndex, zoneWorldCorners, type Zone } from '@/lib/zones';
import { computeZoneDragPatch, type DragKind, type DragState, type Vec2, type Vec3 } from './zoneDrag';

type Project = (worldPos: Vec3) => Vec2 | null;

/** Wireframe edges as pairs of corner indices, matching `zoneWorldCorners`'
 *  bottom-face-then-top-face order (0-3 bottom, 4-7 top). */
const BOX_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0], // bottom
  [4, 5], [5, 6], [6, 7], [7, 4], // top
  [0, 4], [1, 5], [2, 6], [3, 7], // verticals
];

function rgbToCss([r, g, b]: readonly [number, number, number], alpha: number): string {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

/** One rendered box: projected corner screen positions + the zone/colour it
 *  came from. `null` corners (offscreen / behind camera) drop the whole box
 *  from rendering rather than drawing a corrupted hull. */
interface ProjectedZone {
  setId: string;
  setName: string;
  zone: Zone;
  color: readonly [number, number, number];
  corners: Vec2[];
  labelAnchor: Vec2;
}

function projectZones(
  project: Project,
  zoneSets: ReadonlyArray<{ id: string; name: string; visible: boolean; zones: Zone[] }>,
): ProjectedZone[] {
  const out: ProjectedZone[] = [];
  for (const set of zoneSets) {
    if (!set.visible) continue;
    set.zones.forEach((zone, index) => {
      const worldCorners = zoneWorldCorners(zone);
      const corners: Vec2[] = [];
      let ok = true;
      for (const [x, y, z] of worldCorners) {
        const p = project({ x, y, z });
        if (!p) { ok = false; break; }
        corners.push(p);
      }
      if (!ok) return;
      // Label anchors above the top face's center (average of corners 4-7).
      const top = worldCorners.slice(4);
      const topCenter: Vec3 = {
        x: top.reduce((s, c) => s + c[0], 0) / 4,
        y: top.reduce((s, c) => s + c[1], 0) / 4 + 0.3,
        z: top.reduce((s, c) => s + c[2], 0) / 4,
      };
      const labelAnchor = project(topCenter);
      if (!labelAnchor) return;
      out.push({
        setId: set.id,
        setName: set.name,
        zone,
        color: zone.color ?? zoneColorForIndex(index),
        corners,
        labelAnchor,
      });
    });
  }
  return out;
}

const HANDLE_HIT_RADIUS = 10;

export function ZoneOverlay() {
  const zoneSets = useViewerStore((s) => s.zoneSets);
  const editingZone = useViewerStore((s) => s.editingZone);
  const updateZone = useViewerStore((s) => s.updateZone);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const getViewpoint = useViewerStore((s) => s.cameraCallbacks.getViewpoint);

  const anyVisible = zoneSets.some((zs) => zs.visible && zs.zones.length > 0);
  // The returned frame tick MUST participate in the projection memo below:
  // `projectToScreen` is a stable callback, so without the tick an orbit/pan/
  // zoom re-render would reuse the memoized screen coordinates and the boxes
  // would visibly detach from the model (PR #1869 review, P1).
  const frameTick = useCameraTickSubscription(getViewpoint, anyVisible);

  const dragRef = useRef<DragState | null>(null);

  const projected = useMemo(() => {
    if (!projectToScreen || !anyVisible) return [];
    return projectZones(projectToScreen as Project, zoneSets);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- frameTick is the
    // camera-motion signal: it isn't read inside, but a new tick means the
    // same world corners project to new screen positions.
  }, [zoneSets, projectToScreen, anyVisible, frameTick]);

  if (!anyVisible || !projectToScreen) return null;
  const project = projectToScreen as Project;

  const editingEntry = editingZone
    ? projected.find((p) => p.setId === editingZone.setId && p.zone.id === editingZone.zoneId)
    : undefined;

  /** Probe `+1` world unit along `dir` from `origin`, returning screen
   *  pixels-per-metre in that direction (or null if degenerate/offscreen). */
  const probeScreenPerUnit = (origin: Vec3, dir: Vec3): Vec2 | null => {
    const originScreen = project(origin);
    const tipScreen = project({ x: origin.x + dir.x, y: origin.y + dir.y, z: origin.z + dir.z });
    if (!originScreen || !tipScreen) return null;
    const d = { x: tipScreen.x - originScreen.x, y: tipScreen.y - originScreen.y };
    if (Math.hypot(d.x, d.y) < 1e-3) return null;
    return d;
  };

  const startDrag = (
    e: React.PointerEvent<SVGElement>,
    entry: ProjectedZone,
    op: DragKind,
    probeOrigin: Vec3,
    probeDir: Vec3,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const screenPerUnit = probeScreenPerUnit(probeOrigin, probeDir);
    if (!screenPerUnit) return;
    (e.target as SVGElement).setPointerCapture(e.pointerId);

    dragRef.current = {
      op,
      setId: entry.setId,
      zoneId: entry.zone.id,
      cursorStart: { x: e.clientX, y: e.clientY },
      screenPerUnit,
      probeDir,
      startCenter: entry.zone.center,
      startSize: entry.zone.size,
      startRotationY: entry.zone.rotationY,
    };
  };

  const onDragMove = (e: React.PointerEvent<SVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // All the drag math is in `computeZoneDragPatch` (pure, unit-tested —
    // see zoneDrag.test.ts for the rotated-zone cases from PR #1869).
    const patch = computeZoneDragPatch(drag, { x: e.clientX, y: e.clientY });
    if (patch) updateZone(drag.setId, drag.zoneId, patch);
  };

  const onDragEnd = (e: React.PointerEvent<SVGElement>) => {
    if (!dragRef.current) return;
    try {
      (e.target as SVGElement).releasePointerCapture(e.pointerId);
    } catch (error) {
      // Expected when capture was already released (e.g. pointercancel then
      // pointerup); logged so a genuine capture bug can't hide here.
      console.debug('[zones] releasePointerCapture after drag was a no-op', error);
    }
    dragRef.current = null;
  };

  return (
    <svg className="absolute inset-0 pointer-events-none z-20" style={{ overflow: 'visible' }}>
      {projected.map((entry) => {
        const isEditing = editingZone?.setId === entry.setId && editingZone.zoneId === entry.zone.id;
        const stroke = rgbToCss(entry.color, isEditing ? 1 : 0.85);
        const fill = rgbToCss(entry.color, isEditing ? 0.18 : 0.1);
        const topFace = [entry.corners[4], entry.corners[5], entry.corners[6], entry.corners[7]]
          .map((p) => `${p.x},${p.y}`).join(' ');
        return (
          <g key={`${entry.setId}:${entry.zone.id}`}>
            <polygon points={topFace} fill={fill} stroke="none" />
            {BOX_EDGES.map(([a, b], i) => (
              <line
                key={i}
                x1={entry.corners[a].x} y1={entry.corners[a].y}
                x2={entry.corners[b].x} y2={entry.corners[b].y}
                stroke={stroke}
                strokeWidth={isEditing ? 2 : 1.25}
                strokeDasharray={isEditing ? undefined : '4,3'}
              />
            ))}
            <g transform={`translate(${entry.labelAnchor.x}, ${entry.labelAnchor.y})`}>
              <rect x={-2} y={-14} width={entry.zone.name.length * 6.4 + 12} height={18} rx={4}
                fill="rgba(15, 23, 42, 0.85)" />
              <text x={4} y={-1} fontSize={11} fill="#fff">
                {entry.setName} / {entry.zone.name}
              </text>
            </g>
          </g>
        );
      })}

      {editingEntry && (() => {
        const zone = editingEntry.zone;
        const center: Vec3 = { x: zone.center[0], y: zone.center[1], z: zone.center[2] };
        const cos = Math.cos(zone.rotationY);
        const sin = Math.sin(zone.rotationY);
        const localX: Vec3 = { x: cos, y: 0, z: sin };
        const localZ: Vec3 = { x: -sin, y: 0, z: cos };
        const worldY: Vec3 = { x: 0, y: 1, z: 0 };

        const handles: Array<{
          key: string; world: Vec3; color: string; op: DragKind; probeOrigin: Vec3; probeDir: Vec3;
        }> = [
          {
            key: 'move-x',
            world: { x: center.x + localX.x * (zone.size[0] / 2 + 0.6), y: center.y, z: center.z + localX.z * (zone.size[0] / 2 + 0.6) },
            color: '#ef4444',
            op: { kind: 'move' },
            probeOrigin: center,
            probeDir: localX,
          },
          {
            key: 'move-z',
            world: { x: center.x + localZ.x * (zone.size[2] / 2 + 0.6), y: center.y, z: center.z + localZ.z * (zone.size[2] / 2 + 0.6) },
            color: '#3b82f6',
            op: { kind: 'move' },
            probeOrigin: center,
            probeDir: localZ,
          },
          {
            key: 'move-y',
            world: { x: center.x, y: center.y + zone.size[1] / 2 + 0.6, z: center.z },
            color: '#10b981',
            op: { kind: 'move' },
            probeOrigin: center,
            probeDir: worldY,
          },
          {
            key: 'resize-x',
            world: { x: center.x + localX.x * (zone.size[0] / 2), y: center.y, z: center.z + localX.z * (zone.size[0] / 2) },
            color: '#fca5a5',
            op: { kind: 'resize', axis: 'x' },
            probeOrigin: center,
            probeDir: localX,
          },
          {
            key: 'resize-z',
            world: { x: center.x + localZ.x * (zone.size[2] / 2), y: center.y, z: center.z + localZ.z * (zone.size[2] / 2) },
            color: '#93c5fd',
            op: { kind: 'resize', axis: 'z' },
            probeOrigin: center,
            probeDir: localZ,
          },
          {
            key: 'resize-y',
            world: { x: center.x, y: center.y + zone.size[1] / 2, z: center.z },
            color: '#6ee7b7',
            op: { kind: 'resize', axis: 'y' },
            probeOrigin: center,
            probeDir: worldY,
          },
          {
            key: 'rotate',
            world: {
              x: center.x + localX.x * (zone.size[0] / 2 + 1.2),
              y: center.y,
              z: center.z + localX.z * (zone.size[0] / 2 + 1.2),
            },
            color: '#facc15',
            op: { kind: 'rotate' },
            probeOrigin: center,
            probeDir: { x: -localX.z, y: 0, z: localX.x }, // tangent direction at the handle
          },
        ];

        return (
          <g style={{ pointerEvents: 'auto' }}>
            {handles.map((h) => {
              const screen = project(h.world);
              if (!screen) return null;
              return (
                <circle
                  key={h.key}
                  cx={screen.x}
                  cy={screen.y}
                  r={HANDLE_HIT_RADIUS}
                  fill={h.color}
                  stroke="#18181b"
                  strokeWidth={1.5}
                  style={{ cursor: h.op.kind === 'rotate' ? 'grab' : 'move' }}
                  onPointerDown={(e) => startDrag(e, editingEntry, h.op, h.probeOrigin, h.probeDir)}
                  onPointerMove={onDragMove}
                  onPointerUp={onDragEnd}
                  onPointerCancel={onDragEnd}
                />
              );
            })}
          </g>
        );
      })()}
    </svg>
  );
}

/** Mounts the assignment-recompute wiring (`useZoneAssignmentSync`) without
 *  rendering anything. Mount once near `ZoneOverlay` (same lifetime as the
 *  renderer) so `zoneAssignments` stays live as models/zones change. */
export function ZoneAssignmentSyncMount() {
  useZoneAssignmentSync();
  return null;
}
