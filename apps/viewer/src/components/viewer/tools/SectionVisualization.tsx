/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section tool's scene side on the scene-overlay kernel (#5501,
 * charter #5478 §6): the face-picked plane's drag gizmo and the face-pick
 * hover preview, drawn with the shared primitives (`AxisArrow`, `Handle`,
 * `PlaneOutline`) on the one projector loop `SceneOverlayRoot` runs. The
 * two hand-rolled `requestAnimationFrame` + `projectToScreen` loops this
 * file and `SectionPlaneDragGizmo` used to own are gone, as is their own
 * `<svg>` layer: every mark portals into the kernel's SVG layer.
 *
 * Colour (#5488): the plane is the thing being manipulated, so the gizmo
 * and the preview draw in the one interaction accent for every axis and
 * for face-picked planes alike, matching the GPU plane quad
 * `Renderer.setOverlayTheme` tints with the same token.
 */

import { useCallback, useEffect, useId, useRef } from 'react';
import { customPlaneCenter, useViewerStore } from '@/store';
import type { CustomSectionPlane } from '@/store/types';
import { useTranslation } from '@/i18n';
import { capturePointer, releasePointer } from '@/lib/pointer-capture';
import { AxisArrow, Handle, PlaneOutline, useSceneProjector } from '../../viewport-ui/scene';
import { isAnchorVisible, vec3Key } from '../../viewport-ui/scene/projection';
import { useWakeOnChange } from '../../viewport-ui/scene/useWakeOnChange';
import type { ScreenPoint, Vec3 } from '../../viewport-ui/scene/types';
import { sectionPickPreviewAnchors } from './sectionPickPreviewAnchors';
import type { SectionPickPreview } from '@/store/slices/sectionSlice';

const toVec3 = (p: readonly [number, number, number]): Vec3 => ({ x: p[0], y: p[1], z: p[2] });

/** On-screen length of the drag gizmo's arrow, CSS px, whatever the camera distance. */
const GIZMO_ARROW_PX = 60;
/** On-screen length of the pick preview's normal telltale: small, so it never competes with the quad. */
const PREVIEW_ARROW_PX = 36;

interface SectionPlaneVisualizationProps {
  enabled: boolean;
}

export function SectionPlaneVisualization({ enabled }: SectionPlaneVisualizationProps) {
  const customPlane = useViewerStore((s) => s.sectionPlane.custom);
  const setSectionCustomDistance = useViewerStore((s) => s.setSectionCustomDistance);
  const setPreviewStride = useViewerStore((s) => s.setPointCloudPreviewStride);
  const pointCloudAssetCount = useViewerStore((s) => s.pointCloudAssetCount);
  // Live face-pick hover preview (issue #243 follow-up): set while pick mode
  // is armed and the cursor has dwelled ~200 ms over a surface.
  const sectionPickPreview = useViewerStore((s) => s.sectionPickPreview);

  const onDragStart = useCallback(() => { if (pointCloudAssetCount > 0) setPreviewStride(4); }, [pointCloudAssetCount, setPreviewStride]);
  const onDragEnd = useCallback(() => setPreviewStride(1), [setPreviewStride]);

  return (
    <>
      {enabled && customPlane && (
        <SectionPlaneDragGizmo customPlane={customPlane} setDistance={setSectionCustomDistance} onDragStart={onDragStart} onDragEnd={onDragEnd} />
      )}
      {sectionPickPreview && <SectionPickPreviewOverlay preview={sectionPickPreview} />}
    </>
  );
}

/**
 * Click+drag handle that slides the custom section plane along its picked
 * normal. The foot sits at `pickedAt` projected onto the LIVE plane
 * (`customPlaneCenter`): as `distance` changes only the plane moves, and a
 * gizmo anchored to `pickedAt` itself would be stranded at the original
 * pick while the cut slid away. The drag converts cursor pixels to metres
 * through the screen-projected normal (`foot -> foot + normal * 1 m`), read
 * from the same projector tick that places the marks — resolution-
 * independent and correct for any tilt. Orbit/pan still work underneath:
 * only the handle's circle takes pointer events.
 */
export function SectionPlaneDragGizmo(props: {
  customPlane: CustomSectionPlane;
  setDistance: (d: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const { t } = useTranslation();
  const { customPlane, setDistance, onDragStart, onDragEnd } = props;
  const projector = useSceneProjector();
  const id = useId();

  const center = customPlaneCenter(customPlane);
  const foot: Vec3 = { x: center[0], y: center[1], z: center[2] };
  const tip: Vec3 = { x: center[0] + customPlane.normal[0], y: center[1] + customPlane.normal[1], z: center[2] + customPlane.normal[2] };

  // The latest screen positions of foot and tip, written by the shared
  // projector — no loop of this component's own.
  const latest = useRef({ foot, tip });
  latest.current = { foot, tip };
  const screen = useRef<{ foot: ScreenPoint | null; tip: ScreenPoint | null }>({ foot: null, tip: null });
  useEffect(() => {
    if (!projector) return;
    const unFoot = projector.registerAnchor(`${id}-foot`, () => latest.current.foot, (p) => { screen.current.foot = isAnchorVisible(p) ? p.screen : null; });
    const unTip = projector.registerAnchor(`${id}-tip`, () => latest.current.tip, (p) => { screen.current.tip = isAnchorVisible(p) ? p.screen : null; });
    return () => { unFoot(); unTip(); };
  }, [projector, id]);
  useWakeOnChange(projector, `${vec3Key(foot)}|${vec3Key(tip)}`);

  const dragRef = useRef<{
    startDistance: number;
    startCursor: ScreenPoint;
    screenNormal: ScreenPoint;
    pixelsPerMeter: number;
  } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    const { foot: f, tip: tp } = screen.current;
    if (!f || !tp) return;
    e.stopPropagation();
    e.preventDefault();
    const dx = tp.x - f.x;
    const dy = tp.y - f.y;
    const ppm = Math.hypot(dx, dy);
    if (ppm < 1e-3) return; // edge-on view — a drag would be unstable
    // Capture only once a drag will start: an edge-on bail would leave it held (#5403).
    capturePointer(e.target as Element, e.pointerId);
    dragRef.current = {
      startDistance: customPlane.distance,
      startCursor: { x: e.clientX, y: e.clientY },
      screenNormal: { x: dx / ppm, y: dy / ppm },
      pixelsPerMeter: ppm,
    };
    onDragStart();
  }, [customPlane.distance, onDragStart]);

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    const s = dragRef.current;
    if (!s) return;
    e.stopPropagation();
    const cdx = e.clientX - s.startCursor.x;
    const cdy = e.clientY - s.startCursor.y;
    // Project the cursor delta onto the screen-projected normal, then pixels -> metres.
    const along = cdx * s.screenNormal.x + cdy * s.screenNormal.y;
    setDistance(s.startDistance + along / s.pixelsPerMeter);
  }, [setDistance]);

  const handlePointerUp = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    releasePointer(e.target as Element, e.pointerId);
    onDragEnd();
  }, [onDragEnd]);

  // Fragments, not a wrapper `<g>`: each primitive portals its own element
  // into the kernel's SVG layer.
  return (
    <>
      <AxisArrow foot={foot} tip={tip} lengthPx={GIZMO_ARROW_PX} variant="accent" className="stroke-[3px]" />
      <Handle
        worldPoint={foot}
        active
        radius={10}
        title={t('sectionTool.gizmo.dragTitle')}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
    </>
  );
}

/**
 * The "you'll cut here" hint painted on the hovered face while pick mode
 * is armed: the plane's own styling (`PlaneOutline`, accent-soft fill with
 * an accent edge) as a square laid on the face, plus a short normal
 * telltale. Purely visual and click-through — `selectionHandlers.ts`
 * commits the cut on click. `null` anchors (a non-finite pick, #2495)
 * paint nothing rather than NaN coordinates.
 */
function SectionPickPreviewOverlay({ preview }: { preview: SectionPickPreview }) {
  const anchors = sectionPickPreviewAnchors(preview.point, preview.normal);
  if (!anchors) return null;
  return (
    <>
      <PlaneOutline corners={anchors.corners.map(toVec3)} className="stroke-[1.5px]" />
      <AxisArrow foot={toVec3(anchors.foot)} tip={toVec3(anchors.tip)} lengthPx={PREVIEW_ARROW_PX} variant="accent" />
    </>
  );
}
