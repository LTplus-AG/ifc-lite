/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every cutting plane, marked in the scene (#7545): its name tag, an arrow to the
 * side that STAYS (what Flip changes), and for the planes the GPU does not draw a
 * quad for, a dashed outline of their rectangle.
 *
 * Without these a cardinal cut has no presence at all once it is cutting: you
 * moved an invisible thing by scrubbing a 72-pixel number. The planes tell
 * themselves apart by state, never by colour (#5488): the active plane's tag is
 * filled and accented, the others are plain; a plane that is not cutting is hollow.
 *
 * Positions come from the renderer's own resolution of each plane
 * (`sectionPlaneFrame.ts`), read on every projector tick, so they are exact for a
 * rotated building and need no copy of that logic here.
 */

import { createPortal } from 'react-dom';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { AxisArrow, PlaneOutline, useSceneLayer, useWorldAnchor, type Vec3 } from '../../viewport-ui/scene';
import type { SectionPlaneFrame } from '@ifc-lite/renderer';
import type { SectionPlane } from '@/store/types';
import { planeFrame } from './sectionPlaneFrame';
import { useSectionPlaneSet } from './useSectionPlaneSet';

const TAG_SURFACE = 'bg-popover/94 backdrop-blur-md border rounded-md shadow-sm';
/** On-screen length of the kept-side arrow: a hint, never competing with the plane. */
const KEPT_ARROW_PX = 28;

const toVec = (p: readonly number[]): Vec3 => ({ x: p[0]!, y: p[1]!, z: p[2]! });

/** How much of the plane's width the tags of one scene spread over. */
const TAG_SPREAD = 0.3;

/**
 * Where a plane's tag and arrow sit: its anchor (the model's centre projected onto the plane), moved
 * along the plane's own width by its place in the set. Planes that share an anchor, as parallel
 * ones do, then do not stack their tags on top of one another.
 */
function spreadAnchor(frame: SectionPlaneFrame, index: number, count: number): Vec3 {
  const [a, b] = frame.corners;
  const shift = (index - (count - 1) / 2) * TAG_SPREAD;
  return {
    x: frame.anchor[0] + (b[0] - a[0]) * shift,
    y: frame.anchor[1] + (b[1] - a[1]) * shift,
    z: frame.anchor[2] + (b[2] - a[2]) * shift,
  };
}

export function SectionPlaneMarks() {
  const { planes, active, count } = useSectionPlaneSet();
  const visible = useViewerStore((s) => s.sceneState.section.visible);
  // No marks for the untouched placeholder (nothing is cut), nor for a box: a box has no plane to mark.
  if (!visible || count === 0) return null;
  const shown = planes.filter((p) => p.showGizmo && !p.box);
  return (
    <>
      {shown.map((plane, index) => (
        <PlaneMark key={plane.id} plane={plane} index={index} count={shown.length} isActive={plane.id === active.id} />
      ))}
    </>
  );
}

function PlaneMark({ plane, index, count, isActive }: { plane: SectionPlane; index: number; count: number; isActive: boolean }) {
  // Re-read on every render: the store changed, so the plane may have moved.
  const frame = planeFrame(plane.id);
  // The kept side is where `(dot(p, n) - d) * side <= 0`: behind the plane, or in front of it once flipped.
  const keep = plane.flipped ? 1 : -1;
  const anchor = frame ? spreadAnchor(frame, index, count) : null;
  const tip = frame && anchor ? { x: anchor.x + keep * frame.normal[0], y: anchor.y + keep * frame.normal[1], z: anchor.z + keep * frame.normal[2] } : null;
  return (
    <>
      {/* The GPU draws the active plane's own quad; the others get an outline. */}
      {!isActive && frame && (
        <PlaneOutline corners={frame.corners.map(toVec)} className={cn('stroke-[1.5px] [stroke-dasharray:6_4]', plane.enabled ? 'opacity-80' : 'opacity-40')} />
      )}
      {plane.enabled && <AxisArrow foot={anchor} tip={tip} lengthPx={KEPT_ARROW_PX} variant="accent" className="stroke-[2px]" />}
      <PlaneTag plane={plane} index={index} count={count} isActive={isActive} />
    </>
  );
}

function PlaneTag({ plane, index, count, isActive }: { plane: SectionPlane; index: number; count: number; isActive: boolean }) {
  const { t } = useTranslation();
  const domLayer = useSceneLayer('dom');
  const { ref } = useWorldAnchor<HTMLDivElement>(() => {
    const frame = planeFrame(plane.id);
    return frame ? spreadAnchor(frame, index, count) : null;
  });
  if (!domLayer) return null;
  return createPortal(
    // The outer div's transform belongs to `useWorldAnchor`; the offset from the anchor lives on the
    // inner element, or the per-tick write would clobber it.
    <div ref={ref} style={{ display: 'none' }} data-scene-primitive="plane-tag" data-plane-id={plane.id} className="pointer-events-none absolute left-0 top-0 will-change-transform">
      <div
        title={t('sectionPlanes.tag.keptSide', { name: plane.name })}
        className={cn(
          TAG_SURFACE,
          'inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-xs font-medium',
          isActive ? 'border-overlay-accent bg-overlay-accent-soft text-overlay-accent' : 'border-border text-overlay-ink',
        )}
        style={{ transform: 'translate(10px, -12px)' }}
      >
        <span aria-hidden className={cn('inline-block h-1.5 w-1.5 rounded-full border border-current', plane.enabled && 'bg-current')} />
        {plane.name}
      </div>
    </div>,
    domLayer,
  );
}
