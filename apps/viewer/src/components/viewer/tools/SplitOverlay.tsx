/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live SVG preview for the `element.split` command (#6232; was the Split
 * tool's overlay). Mounted through the command's `hud.Scene`, reading the
 * command gesture. Branches by element type:
 *
 *   Wall / beam / column / member (single click): a perpendicular guide
 *     through the projected cut point and a "distance / length" readout.
 *
 *   Slab / roof / plate / space (two clicks): the footprint outlined with a
 *     faint accent stroke; after the first click, a ghost line anchor →
 *     cursor (the real extent is clamped by polygon-clip at commit).
 *
 * Every point goes through the target storey's workplane, so the preview sits
 * where the commit will cut, on a moved, rotated or georeferenced model too.
 * Re-projection rides the shared scene-overlay kernel's tick (#5486/#5512)
 * rather than a private rAF loop.
 */

import { useViewerStore } from '@/store';
import type { Vec3 } from '@/lib/commands/modeling/types';
import type { SplitGesture } from '@/lib/commands/modeling/commands/element-split';
import { formatSplitHoverLabel } from './formatDistance';
import { WorldLabel, useProjectorTick } from '../../viewport-ui/scene';

type Screen = { x: number; y: number };

const GUIDE_HALF_LENGTH_PX = 30;
const toWorld = (p: Vec3) => ({ x: p[0], y: p[1], z: p[2] });

export function SplitOverlay({ gesture }: { gesture: SplitGesture }) {
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const { plane, footprint, hover, anchor, cursor } = gesture;
  const active = plane !== null && (footprint !== null || hover !== null);
  void useProjectorTick(active);
  if (!active || !plane || !projectToScreen) return null;
  const project = (p: Vec3): Screen | null => projectToScreen(toWorld(p));
  const onFloor = (p: readonly [number, number]) => project(plane.localToRender([p[0], p[1], 0]));

  if (footprint) {
    const verts = footprint.map(onFloor).filter((v): v is Screen => v !== null);
    if (verts.length < 3) return null;
    const path = verts.map((v, i) => `${i === 0 ? 'M' : 'L'}${v.x} ${v.y}`).join(' ') + ' Z';
    const anchorScreen = anchor ? onFloor(anchor) : null;
    const cursorScreen = cursor ? onFloor(cursor) : null;
    return (
      <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }}>
        <path d={path} className="fill-overlay-accent stroke-overlay-accent" fillOpacity={0.08} strokeWidth={1.5} strokeDasharray="4 4" />
        {anchorScreen && (
          <circle cx={anchorScreen.x} cy={anchorScreen.y} r={5} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2.5} />
        )}
        {anchorScreen && cursorScreen && (
          <line x1={anchorScreen.x} y1={anchorScreen.y} x2={cursorScreen.x} y2={cursorScreen.y}
            className="stroke-overlay-accent" strokeWidth={3} strokeLinecap="round" />
        )}
        {cursorScreen && (
          <circle cx={cursorScreen.x} cy={cursorScreen.y} r={4} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2} />
        )}
      </svg>
    );
  }

  if (!hover) return null;
  const cutScreen = project(hover.render);
  if (!cutScreen) return null;
  // Perpendicular to the element axis, in screen space.
  let guideDx = 0;
  let guideDy = -1;
  const ahead = project(hover.axisAhead);
  if (ahead) {
    const ax = ahead.x - cutScreen.x, ay = ahead.y - cutScreen.y;
    const len = Math.hypot(ax, ay);
    if (len > 1e-3) { guideDx = -ay / len; guideDy = ax / len; }
  }
  return (
    <>
      <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }}>
        <line
          x1={cutScreen.x - guideDx * GUIDE_HALF_LENGTH_PX} y1={cutScreen.y - guideDy * GUIDE_HALF_LENGTH_PX}
          x2={cutScreen.x + guideDx * GUIDE_HALF_LENGTH_PX} y2={cutScreen.y + guideDy * GUIDE_HALF_LENGTH_PX}
          className="stroke-overlay-accent" strokeWidth={3} strokeLinecap="round" opacity={0.95}
        />
        <circle cx={cutScreen.x} cy={cutScreen.y} r={5} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2.5} />
      </svg>
      {/* Live readout: accent-bordered because it is the thing being set. */}
      <WorldLabel worldPoint={toWorld(hover.render)} active offset={{ dx: 14, dy: -30 }}>
        {formatSplitHoverLabel(hover.distance, hover.length, unitDisplayOverrides)}
      </WorldLabel>
    </>
  );
}
