/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The snap HUD of a running modeling command (charter #6232, WP3): the
 * glyph of what the pointer snapped to (`SnapGlyphShape`, one shape per kind) on
 * the solved point, and the guides that explain it — the snapped edge, a
 * dashed extension / axis / parallel line running to the point, the lock
 * (ortho line, typed-length circle) — plus a dotted drop line when the
 * target sits above or below the workplane (a roof corner snapped in plan).
 *
 * Standalone: it reads nothing but its props, so any command HUD can mount
 * it; the 2D plan paints the same shapes (`SnapHudShapes`). Overlay tokens only.
 */

import { useViewerStore } from '@/store';
import type { SnapResult, Vec2 } from '@/lib/snap/types';
import type { Workplane } from '@/lib/commands/modeling/types';
import { SnapGlyphShape, useProjectorTick } from '../../../viewport-ui/scene';
import { glyphFor, guideStrokes, type GuideStroke } from './snap-hud-geometry';

type Screen = { x: number; y: number };

/** How far an infinite guide runs past the solved point, in CSS px. */
const OVERSHOOT_PX = 28;
const CIRCLE_STEPS = 72;
/** Guides break this far either side of the glyph, so the glyph stays whole on top of them. */
const GLYPH_GAP_PX = 8;
/** Targets closer to the plane than this get no drop line. */
const DROP_MIN_M = 0.01;

const CLASS: Record<'edge' | 'guide' | 'lock', string> = {
  edge: 'stroke-overlay-accent-soft',
  guide: 'stroke-overlay-accent',
  lock: 'stroke-overlay-ink-muted',
};

export interface SnapHudProps {
  snap: SnapResult | null;
  plane: Workplane | null;
}

export function SnapHud({ snap, plane }: SnapHudProps) {
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  void useProjectorTick(snap !== null && plane !== null);
  if (!snap || !plane || !projectToScreen) return null;
  const screen = (p: Vec2, z = 0): Screen | null => {
    const r = plane.localToRender([p[0], p[1], z]);
    return projectToScreen({ x: r[0], y: r[1], z: r[2] });
  };
  return (
    <svg
      className="absolute inset-0 pointer-events-none z-(--z-scene)"
      style={{ overflow: 'visible' }}
      data-snap-hud=""
    >
      <SnapHudShapes snap={snap} screen={screen} />
    </svg>
  );
}

/**
 * The guides, drop line and glyph for `snap`, painted through `screen`
 * (workplane-local metres, height above the plane → CSS px). The 3D HUD
 * projects through the camera; the 2D plan (`PlanView`) through its `Fit`,
 * so both views show the same snap the same way.
 */
export function SnapHudShapes({ snap, screen }: { snap: SnapResult; screen: (p: Vec2, z?: number) => Screen | null }) {
  const glyph = glyphFor(snap);
  const at = glyph ? screen(snap.local) : null;
  const winner = snap.winner;
  const drop = winner?.elevation !== undefined && Math.abs(winner.elevation) > DROP_MIN_M
    ? [screen(winner.local, winner.elevation), screen(winner.local)]
    : null;
  return (
    <>
      {guideStrokes(snap).map((s, i) => <GuidePath key={i} stroke={s} screen={screen} gapAt={at} />)}
      {drop?.[0] && drop[1] && (drop[0].x !== drop[1].x || drop[0].y !== drop[1].y) && (
        <line
          x1={drop[0].x} y1={drop[0].y} x2={drop[1].x} y2={drop[1].y}
          className={CLASS.lock} strokeWidth={1} strokeDasharray="1 3" strokeLinecap="round"
          data-snap-guide="drop"
        />
      )}
      {/* After the guides and above the command's own layer: the snap is the live feedback. */}
      {glyph && at && (
        <g transform={`translate(${at.x} ${at.y})`} data-scene-primitive="snap-glyph" data-snap-kind={glyph}>
          <SnapGlyphShape kind={glyph} />
        </g>
      )}
    </>
  );
}

/** The pieces of a→b outside a gap around `p`, when p lies on the line (else a→b whole). */
function breakAround(a: Screen, b: Screen, p: Screen | null): [Screen, Screen][] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!p || len === 0) return [[a, b]];
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const t = (p.x - a.x) * ux + (p.y - a.y) * uy;
  const off = Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux);
  if (off > 1.5 || t < -GLYPH_GAP_PX || t > len + GLYPH_GAP_PX) return [[a, b]];
  const at = (d: number): Screen => ({ x: a.x + ux * d, y: a.y + uy * d });
  const pieces: [Screen, Screen][] = [];
  if (t - GLYPH_GAP_PX > 0) pieces.push([a, at(t - GLYPH_GAP_PX)]);
  if (t + GLYPH_GAP_PX < len) pieces.push([at(t + GLYPH_GAP_PX), b]);
  return pieces;
}

/** A guide line over a halo underlay, so it stays legible on coloured geometry; broken around the glyph. */
function HaloLine({ a, b, gapAt, className, width, dash, role }: {
  a: Screen; b: Screen; gapAt: Screen | null; className: string; width: number; dash?: string; role: string;
}) {
  return (
    <g data-snap-guide={role}>
      {breakAround(a, b, gapAt).map(([p, q], i) => (
        <g key={i}>
          <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="stroke-overlay-halo" strokeOpacity={0.7} strokeWidth={width + 2} strokeDasharray={dash} strokeLinecap="round" />
          <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} className={className} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" />
        </g>
      ))}
    </g>
  );
}

function GuidePath({ stroke, screen, gapAt }: { stroke: GuideStroke; screen: (p: Vec2) => Screen | null; gapAt: Screen | null }) {
  const tone = stroke.role === 'lock' ? CLASS.lock : stroke.role === 'edge' ? CLASS.edge : CLASS.guide;
  if (stroke.kind === 'circle') {
    const pts: Screen[] = [];
    for (let i = 0; i <= CIRCLE_STEPS; i++) {
      const t = (i / CIRCLE_STEPS) * Math.PI * 2;
      const p = screen([stroke.center[0] + stroke.radius * Math.cos(t), stroke.center[1] + stroke.radius * Math.sin(t)]);
      if (!p) return null;
      pts.push(p);
    }
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
    return <path d={d} fill="none" className={tone} strokeWidth={1} strokeDasharray="4 4" data-snap-guide={stroke.role} />;
  }
  const a = screen(stroke.kind === 'segment' ? stroke.a : stroke.from);
  const b = screen(stroke.kind === 'segment' ? stroke.b : stroke.to);
  if (!a || !b) return null;
  if (stroke.kind === 'segment') {
    // The snapped edge is highlighted solid; a perpendicular drop is dashed.
    const dashed = stroke.role !== 'edge';
    return <HaloLine a={a} b={b} gapAt={gapAt} className={tone} width={dashed ? 1.5 : 3} dash={dashed ? '5 4' : undefined} role={stroke.role} />;
  }
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const k = len > 0 ? OVERSHOOT_PX / len : 0;
  const end = { x: b.x + (b.x - a.x) * k, y: b.y + (b.y - a.y) * k };
  return <HaloLine a={a} b={end} gapAt={gapAt} className={tone} width={1.5} dash="5 4" role={stroke.role} />;
}
