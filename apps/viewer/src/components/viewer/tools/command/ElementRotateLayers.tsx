/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.rotate`'s layers (charter #6232, C2): the rotate ring round the
 * pivot — 15° ticks, the start ray, the swept arc and the live angle — drawn
 * in the 3D view (projected off the workplane) and in the plan, from ONE ring
 * geometry (`ringGeometry`), plus the bar's Pivot toggle.
 */

import { Crosshair } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { shortcutLabel } from '@/lib/commands/shortcut-label';
import { updateCommandGesture } from '@/lib/commands/modeling/runtime';
import type { CommandHudProps, CommandPlanProps } from '@/lib/commands/modeling/types';
import type { Vec2 } from '@/lib/snap/types';
import { ringGeometry, togglePivotPick, type ElementRotateGesture, type RingGeometry } from '@/lib/commands/modeling/commands/element-rotate-geometry';
import { HudDivider, HudToggle } from '../../../viewport-ui/hud';
import { useProjectorTick } from '../../../viewport-ui/scene';

type Project = (p: Vec2) => readonly [number, number] | null;

const formatDeg = (deg: number) => `${Math.round(deg * 10) / 10}°`;

/** The ring is never drawn smaller than this on screen, however far out the view is. */
const MIN_RING_PX = 56;

/** The ring radius (metres) that keeps it at least `MIN_RING_PX` across in `project`. */
function screenRadius(g: ElementRotateGesture, project: Project): number {
  const pivot = g.pivot;
  if (!pivot) return g.radius;
  const c = project(pivot);
  const px = [[1, 0], [0, 1]].map(([dx, dy]) => {
    const p = project([pivot[0] + dx, pivot[1] + dy]);
    return c && p ? Math.hypot(p[0] - c[0], p[1] - c[1]) : 0;
  });
  const perMetre = Math.max(px[0], px[1]);
  return perMetre > 0 ? Math.max(g.radius, MIN_RING_PX / perMetre) : g.radius;
}

function path(points: readonly Vec2[], project: Project, close = false): string | null {
  const screen = points.map(project);
  if (screen.some((p) => p === null)) return null;
  return (screen as [number, number][]).map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`).join(' ') + (close ? ' Z' : '');
}

/** The ring, in whatever projection the host layer gives. */
function Ring({ ring, pivot, picking, project }: { ring: RingGeometry; pivot: Vec2; picking: boolean; project: Project }) {
  const circle = path(ring.circle, project, true);
  const centre = project(pivot);
  if (!circle || !centre) return null;
  const label = ring.labelAt ? project(ring.labelAt) : null;
  const wedge = ring.arc.length > 1 ? path([pivot, ...ring.arc], project, true) : null;
  return (
    <g data-rotate-ring pointerEvents="none">
      <path d={circle} className="stroke-overlay-accent" fill="none" strokeWidth={2} />
      {ring.ticks.map((tick, i) => {
        const d = path([tick.from, tick.to], project);
        return d ? <path key={i} d={d} className="stroke-overlay-accent" strokeWidth={tick.major ? 2 : 1} /> : null;
      })}
      {wedge && <path d={wedge} className="fill-overlay-accent stroke-overlay-accent" fillOpacity={0.15} strokeWidth={1} />}
      {[ring.startRay, ring.nowRay].map((ray, i) => {
        const d = ray ? path(ray, project) : null;
        return d ? <path key={i} d={d} className="stroke-overlay-accent" strokeWidth={2} strokeDasharray={i === 0 ? '4 3' : undefined} /> : null;
      })}
      <circle cx={centre[0]} cy={centre[1]} r={picking ? 6 : 4} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2} />
      {label && ring.deg !== null && (
        <text x={label[0]} y={label[1]} textAnchor="middle" className="fill-overlay-accent text-2xs font-medium tabular-nums" data-rotate-angle>
          {formatDeg(ring.deg)}
        </text>
      )}
    </g>
  );
}

export function ElementRotateScene({ gesture, ctx }: CommandHudProps<ElementRotateGesture>) {
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const plane = ctx.workplane;
  void useProjectorTick(plane !== null && gesture.pivot !== null);
  if (!plane || !gesture.pivot || !projectToScreen) return null;
  const project: Project = (p) => {
    const r = plane.localToRender([p[0], p[1], 0]);
    const s = projectToScreen({ x: r[0], y: r[1], z: r[2] });
    return s ? [s.x, s.y] : null;
  };
  const ring = ringGeometry(gesture, screenRadius(gesture, project));
  if (!ring) return null;
  return (
    <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }}>
      <Ring ring={ring} pivot={gesture.pivot} picking={gesture.pickingPivot} project={project} />
    </svg>
  );
}

export function ElementRotatePlan({ gesture, toScreen }: CommandPlanProps<ElementRotateGesture>) {
  const ring = ringGeometry(gesture, screenRadius(gesture, toScreen));
  if (!ring || !gesture.pivot) return null;
  return (
    <g data-plan-command="element.rotate">
      <Ring ring={ring} pivot={gesture.pivot} picking={gesture.pickingPivot} project={toScreen} />
    </g>
  );
}

export function ElementRotateBar({ gesture }: CommandHudProps<ElementRotateGesture>) {
  const { t } = useTranslation();
  return (
    <>
      <HudDivider />
      <HudToggle
        pressed={gesture.pickingPivot}
        onPressedChange={() => updateCommandGesture((g) => togglePivotPick(g as ElementRotateGesture))}
        icon={<Crosshair aria-hidden className="h-3.5 w-3.5" />}
        title={t('moveRotate.rotate.pivotTitle', { key: shortcutLabel('command.element.rotate.pivot') })}
      >
        {t('moveRotate.rotate.pivot')}
      </HudToggle>
    </>
  );
}
