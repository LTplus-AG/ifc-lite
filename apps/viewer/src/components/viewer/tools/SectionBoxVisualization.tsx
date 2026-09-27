/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section box on the scene-overlay kernel (#5513, charter #5478 §6):
 * the six faces of `sectionPlane.box` as `PlaneOutline`s (accent edges, no
 * fill — six washed faces would bury the model) and a `Handle` at each
 * face's centre that drags that face along its axis. The face being
 * dragged gets the plane's own accent-soft fill and a short `AxisArrow`
 * along its normal, so the one thing being manipulated is the one thing
 * in accent, per the one-accent rule.
 *
 * The drag is the plane gizmo's (`SectionPlaneDragGizmo`): cursor pixels
 * are projected onto the screen-projected axis (`centre -> centre + normal
 * * 1 m`, read from the same projector tick that places the marks) and
 * divided by that span's px-per-metre, so it is resolution-independent and
 * right for any view angle; an edge-on face takes no drag. Orbit/pan keep
 * working underneath — only the handles take pointer events.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import type { SectionBox, SectionBoxFace } from '@/store/types';
import { useTranslation } from '@/i18n';
import { capturePointer, releasePointer } from '@/lib/pointer-capture';
import {
  SECTION_BOX_FACES,
  faceSide,
  sectionBoxFaceCenter,
  sectionBoxFaceCorners,
  sectionBoxFaceNormal,
  type Vec3Tuple,
} from '@/lib/section/section-box';
import { AxisArrow, Handle, PlaneOutline, useSceneProjector } from '../../viewport-ui/scene';
import { isAnchorVisible } from '../../viewport-ui/scene/projection';
import type { ScreenPoint, Vec3 } from '../../viewport-ui/scene/types';

const toVec3 = (p: Vec3Tuple): Vec3 => ({ x: p[0], y: p[1], z: p[2] });
const add = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** On-screen length of the dragged face's normal telltale, CSS px. */
const DRAG_ARROW_PX = 40;
const HANDLE_RADIUS = 8;

export function SectionBoxVisualization() {
  const box = useViewerStore((s) => s.sectionPlane.box);
  if (!box) return null;
  return <SectionBoxGizmo box={box} />;
}

interface FaceScreen { foot: ScreenPoint | null; tip: ScreenPoint | null }

function SectionBoxGizmo({ box }: { box: SectionBox }) {
  const { t } = useTranslation();
  const setSectionBoxFace = useViewerStore((s) => s.setSectionBoxFace);
  const setPreviewStride = useViewerStore((s) => s.setPointCloudPreviewStride);
  const pointCloudAssetCount = useViewerStore((s) => s.pointCloudAssetCount);
  const projector = useSceneProjector();
  const id = useId();
  const [dragging, setDragging] = useState<SectionBoxFace | null>(null);

  // Foot (face centre) and tip (centre + outward normal, 1 m) per face, in
  // world space, read fresh by the projector on every tick.
  const latest = useRef(box);
  latest.current = box;
  const screen = useRef<Record<SectionBoxFace, FaceScreen>>({
    minX: { foot: null, tip: null }, maxX: { foot: null, tip: null },
    minY: { foot: null, tip: null }, maxY: { foot: null, tip: null },
    minZ: { foot: null, tip: null }, maxZ: { foot: null, tip: null },
  });
  useEffect(() => {
    if (!projector) return;
    const unregisters = SECTION_BOX_FACES.flatMap((face) => [
      projector.registerAnchor(`${id}-${face}-foot`, () => toVec3(sectionBoxFaceCenter(latest.current, face)), (p) => {
        screen.current[face].foot = isAnchorVisible(p) ? p.screen : null;
      }),
      projector.registerAnchor(`${id}-${face}-tip`, () => toVec3(add(sectionBoxFaceCenter(latest.current, face), sectionBoxFaceNormal(face))), (p) => {
        screen.current[face].tip = isAnchorVisible(p) ? p.screen : null;
      }),
    ]);
    return () => { for (const un of unregisters) un(); };
  }, [projector, id]);
  // No wake of its own: the `Handle`s and `PlaneOutline`s below wake the
  // projector when the box moves, and these anchors ride that same tick.

  const dragRef = useRef<{
    face: SectionBoxFace;
    start: number;
    startCursor: ScreenPoint;
    screenNormal: ScreenPoint;
    pixelsPerMeter: number;
  } | null>(null);

  const handlePointerDown = useCallback((face: SectionBoxFace, e: React.PointerEvent<SVGCircleElement>) => {
    const { foot, tip } = screen.current[face];
    if (!foot || !tip) return;
    e.stopPropagation();
    e.preventDefault();
    const dx = tip.x - foot.x;
    const dy = tip.y - foot.y;
    const ppm = Math.hypot(dx, dy);
    if (ppm < 1e-3) return; // edge-on face — a drag would be unstable
    // Capture only once a drag will start: an edge-on bail would leave it held (#5403).
    capturePointer(e.target as Element, e.pointerId);
    const { corner, axis } = faceSide(face);
    dragRef.current = {
      face,
      start: latest.current[corner][axis],
      startCursor: { x: e.clientX, y: e.clientY },
      screenNormal: { x: dx / ppm, y: dy / ppm },
      pixelsPerMeter: ppm,
    };
    setDragging(face);
    // Scrubbing thins a loaded scan so a >10M-point cloud keeps up (restored on release).
    if (pointCloudAssetCount > 0) setPreviewStride(4);
  }, [pointCloudAssetCount, setPreviewStride]);

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    const d = dragRef.current;
    if (!d) return;
    e.stopPropagation();
    // The cursor delta along the screen-projected outward normal, pixels -> metres.
    const along = (e.clientX - d.startCursor.x) * d.screenNormal.x + (e.clientY - d.startCursor.y) * d.screenNormal.y;
    const { corner } = faceSide(d.face);
    // The normal points OUT of the box, so "along" grows a max face and shrinks a min face.
    setSectionBoxFace(d.face, d.start + (corner === 'max' ? 1 : -1) * (along / d.pixelsPerMeter));
  }, [setSectionBoxFace]);

  const handlePointerUp = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    releasePointer(e.target as Element, e.pointerId);
    setDragging(null);
    setPreviewStride(1);
  }, [setPreviewStride]);

  // Fragments, not a wrapper `<g>`: each primitive portals its own element
  // into the kernel's SVG layer.
  return (
    <>
      {SECTION_BOX_FACES.map((face) => {
        const active = dragging === face;
        const center = sectionBoxFaceCenter(box, face);
        return (
          <FaceMarks
            key={face}
            face={face}
            active={active}
            corners={sectionBoxFaceCorners(box, face).map(toVec3)}
            center={toVec3(center)}
            tip={toVec3(add(center, sectionBoxFaceNormal(face)))}
            title={t('sectionTool.box.handleTitle')}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
        );
      })}
    </>
  );
}

function FaceMarks(props: {
  face: SectionBoxFace;
  active: boolean;
  corners: Vec3[];
  center: Vec3;
  tip: Vec3;
  title: string;
  onPointerDown: (face: SectionBoxFace, e: React.PointerEvent<SVGCircleElement>) => void;
  onPointerMove: React.PointerEventHandler<SVGCircleElement>;
  onPointerUp: React.PointerEventHandler<SVGCircleElement>;
}) {
  const { face, active, corners, center, tip, title, onPointerDown, onPointerMove, onPointerUp } = props;
  const handleDown = useCallback((e: React.PointerEvent<SVGCircleElement>) => onPointerDown(face, e), [face, onPointerDown]);
  return (
    <>
      <PlaneOutline corners={corners} className={active ? 'stroke-[1.5px]' : 'fill-none'} />
      {active && <AxisArrow foot={center} tip={tip} lengthPx={DRAG_ARROW_PX} variant="accent" />}
      <Handle
        worldPoint={center}
        active={active}
        radius={HANDLE_RADIUS}
        title={title}
        onPointerDown={handleDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </>
  );
}
