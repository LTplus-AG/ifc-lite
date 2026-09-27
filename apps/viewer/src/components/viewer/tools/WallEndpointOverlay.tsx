/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Endpoint drag handles for a selected rectangular-profile wall: two SVG
 * circles at the wall's start and end. Grabbing one starts the
 * `wall.moveEndpoint` modeling command (#6232), which ghosts the wall while
 * the pointer is down and writes ONE `resizeWall` on release.
 *
 * Gating:
 *   - `editEnabled` is on and the model is writable
 *   - `activeTool === 'select'`
 *   - the selected entity is a wall with a resolvable wall edit chain —
 *     `readWallEndpoints` returning non-null is the gate — on a storey whose
 *     workplane resolves
 *
 * The ends are storey-local; they are drawn through the wall storey's
 * workplane (`buildStoreyWorkplane`: storey placement chain, RTC, origin
 * shift, federation alignment and the model's reposition placement), the
 * same map the drag writes back through, so a handle sits on the wall on a
 * moved, rotated or georeferenced model too.
 *
 * Re-render wake (#5510): `useProjectorTick` subscribes to the scene kernel's
 * one shared `SceneProjector` loop instead of a private rAF poll.
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { canMutate } from '@/store/mutation-permission';
import { useIfc } from '@/hooks/useIfc';
import { useProjectorTick } from '@/components/viewport-ui/scene';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { beginWallEndpointDrag, type WallEnd } from '@/lib/commands/modeling/commands/wall-move-endpoint';

type Vec2 = { x: number; y: number };
type Vec3 = { x: number; y: number; z: number };
type Project = (worldPos: Vec3) => Vec2 | null;

const HANDLE_RADIUS = 7;

export function WallEndpointOverlay() {
  const editEnabled = useViewerStore((s) => s.editEnabled);
  const collabRole = useViewerStore((s) => s.collabRole);
  const activeTool = useViewerStore((s) => s.activeTool);
  const selectedEntity = useViewerStore((s) => s.selectedEntity);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const readWallEndpoints = useViewerStore((s) => s.readWallEndpoints);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  // A reposition moves the wall without touching any field above; the
  // workplane below reads it, so it is a dependency (#4953 review).
  const modelPlacement = useViewerStore((s) => s.modelPlacement);
  const { models } = useIfc();

  // The wall's ends in render space, re-resolved on every mutation (so a
  // translate/rotate/resize moves the handles) and every reposition. Null
  // when the entity is not a resizable wall.
  const handles = useMemo(() => {
    if (activeTool !== 'select' || !selectedEntity) return null;
    const state = useViewerStore.getState();
    if (!canMutate(state, selectedEntity.modelId)) return null;
    const wall = readWallEndpoints(selectedEntity.modelId, selectedEntity.expressId);
    const storeyId = models.get(selectedEntity.modelId)?.ifcDataStore?.spatialHierarchy?.elementToStorey.get(selectedEntity.expressId);
    if (!wall || storeyId === undefined) return null;
    const plane = buildStoreyWorkplane(state, selectedEntity.modelId, storeyId, 0);
    if (!isWorkplane(plane)) return null;
    const toWorld = (p: [number, number, number]): Vec3 => {
      const [x, y, z] = plane.localToRender(p);
      return { x, y, z };
    };
    return { start: toWorld(wall.start), end: toWorld(wall.end) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editEnabled, collabRole, activeTool, selectedEntity, models, readWallEndpoints, mutationVersion, modelPlacement]);

  // Shared-projector wake (#5510) — re-renders on real viewpoint motion so
  // the projection stays aligned. Skipped when the overlay isn't visible.
  void useProjectorTick(handles !== null);

  if (!handles || !projectToScreen) return null;
  const project = projectToScreen as Project;
  const startScreen = project(handles.start);
  const endScreen = project(handles.end);
  if (!startScreen || !endScreen) return null;

  const grab = (which: WallEnd, e: React.PointerEvent<SVGElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    beginWallEndpointDrag(which);
  };

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
        className="stroke-overlay-accent"
        strokeWidth={1.5}
        strokeDasharray="4 4"
        opacity={0.5}
      />
      {[
        { which: 'start' as const, screen: startScreen },
        { which: 'end' as const, screen: endScreen },
      ].map(({ which, screen }) => (
        <g key={which} data-wall-end={which} style={{ pointerEvents: 'auto' }}>
          {/* Generous hit area so users don't have to land pixel-perfect. */}
          <circle
            cx={screen.x}
            cy={screen.y}
            r={HANDLE_RADIUS + 6}
            fill="transparent"
            style={{ cursor: 'grab' }}
            onPointerDown={(e) => grab(which, e)}
          />
          {/* Visible handle. */}
          <circle
            cx={screen.x}
            cy={screen.y}
            r={HANDLE_RADIUS}
            className="fill-overlay-halo stroke-overlay-accent"
            strokeWidth={2.5}
            pointerEvents="none"
          />
        </g>
      ))}
    </svg>
  );
}
