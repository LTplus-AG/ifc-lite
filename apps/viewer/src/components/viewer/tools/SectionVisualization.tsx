/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane scene visuals.
 *
 * Renders the 3D drag gizmo for face-picked custom planes (issue #243):
 * an accent dot at the live plane anchor (`pickedAt` projected onto the
 * current plane via `customPlaneCenter`) plus an arrow along the picked
 * normal that the user can click + drag to slide the cut plane
 * perpendicular to its surface. Anchoring to the projected center —
 * instead of `pickedAt` directly — keeps the gizmo glued to the plane
 * as `distance` changes; using `pickedAt` directly would freeze the
 * gizmo at the original face-pick location while the geometry clip
 * slides to the new distance. The drag math projects the cursor delta
 * onto the screen-projected normal and converts pixels-per-meter via
 * the camera's point-projection of `center + normal * 1m`.
 *
 * Colour (#5488, charter #5478): the section plane is the thing being
 * manipulated, so the gizmo and pick preview draw in the one interaction
 * accent (`overlay-accent` / `overlay-accent-soft`) for every axis and for
 * face-picked planes alike, matching the GPU plane quad that
 * `Renderer.setOverlayTheme` tints with the same token. The corner axis
 * badge is gone (#5500): the bar and the parked chip carry the state.
 */

import { useEffect, useState } from 'react';
import { sectionPickPreviewAnchors } from './sectionPickPreviewAnchors';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { SectionPlaneDragGizmo } from './SectionPlaneDragGizmo';

interface SectionPlaneVisualizationProps {
  enabled: boolean;
}

export function SectionPlaneVisualization({ enabled }: SectionPlaneVisualizationProps) {
  const customPlane = useViewerStore((s) => s.sectionPlane.custom);
  const setSectionCustomDistance = useViewerStore((s) => s.setSectionCustomDistance);
  const setPreviewStride = useViewerStore((s) => s.setPointCloudPreviewStride);
  const pointCloudAssetCount = useViewerStore((s) => s.pointCloudAssetCount);
  // Live face-pick hover preview (issue #243 follow-up). Only set
  // while pick mode is armed AND the cursor has dwelled ~200ms over a
  // surface. Drives the accent quad + arrow that telegraph "this is
  // where I'll cut if you click here" before the user commits.
  const sectionPickPreview = useViewerStore((s) => s.sectionPickPreview);

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-20"
      style={{ overflow: 'visible', pointerEvents: 'none' }}
    >
      {enabled && customPlane && (
        <SectionPlaneDragGizmo
          customPlane={customPlane}
          setDistance={setSectionCustomDistance}
          onDragStart={() => { if (pointCloudAssetCount > 0) setPreviewStride(4); }}
          onDragEnd={()  => setPreviewStride(1)}
        />
      )}

      {/* Face-pick hover preview — purely visual, click-through. */}
      {sectionPickPreview && (
        <SectionPickPreviewOverlay
          preview={sectionPickPreview}
        />
      )}
    </svg>
  );
}

/**
 * Translucent accent quad + tiny normal arrow painted on the surface
 * the user is hovering while section pick mode is armed (issue #243
 * follow-up). Purely a hint — does not commit a section plane;
 * `selectionHandlers.ts` does that on click.
 *
 * Rendered as an SVG overlay to match `CustomPlaneDragGizmo` (no new
 * GPU pipeline, follows the camera "for free" via per-frame
 * projection). The quad's footprint follows `tangent`/`bitangent` of
 * the hit normal so it looks like a flat square laid on the surface
 * regardless of camera angle, and its on-screen radius is clamped to
 * `[24px, 80px]` so it stays readable from any zoom.
 *
 * Pointer-events are forced off so the overlay never intercepts the
 * click that would commit the actual cut — the SVG container above
 * already disables them, but child <g> elements with `pointerEvents:
 * 'auto'` (e.g. the drag gizmo's circle) co-exist in the same tree.
 */
function SectionPickPreviewOverlay(props: {
  preview: NonNullable<ReturnType<typeof useViewerStore.getState>['sectionPickPreview']>;
}) {
  const { preview } = props;
  // Project the four quad corners + the arrow tip every animation
  // frame so the overlay tracks camera orbit/pan without any extra
  // store subscription. Cheap (5 mat-mul per frame).
  const [proj, setProj] = useState<{
    quad: Array<{ x: number; y: number }>;
    foot: { x: number; y: number };
    tip:  { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    let raf = 0;
    // World-space anchors depend only on the pick, so they are derived once
    // per preview rather than per frame; only the projection is per-frame.
    // `null` means the pick carries nothing drawable (a non-finite point, or a
    // normal with no direction) — paint nothing rather than emitting NaN SVG
    // coordinates (#2495).
    const anchors = sectionPickPreviewAnchors(preview.point, preview.normal);
    if (!anchors) {
      // Drop any projection left over from the previous (drawable) pick so the
      // quad does not linger on the wrong face.
      setProj(null);
      return;
    }
    const project = () => {
      const renderer = getGlobalRenderer();
      const camera = renderer?.getCamera();
      const canvas = renderer?.getCanvas();
      if (camera && canvas) {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const toScreen = (p: readonly [number, number, number]) =>
          camera.projectToScreen({ x: p[0], y: p[1], z: p[2] }, w, h);

        // Quad corners: 0.5m half-extent in world space to start; the
        // apparent size is clamped in screen pixels below by interpolating
        // along the projected diagonal.
        const c0 = toScreen(anchors.corners[0]);
        const c1 = toScreen(anchors.corners[1]);
        const c2 = toScreen(anchors.corners[2]);
        const c3 = toScreen(anchors.corners[3]);
        const foot = toScreen(anchors.foot);
        const tip = toScreen(anchors.tip);

        if (c0 && c1 && c2 && c3 && foot && tip) {
          // On-screen size clamp: rescale the four corners about the
          // foot so the apparent diagonal falls in [24px, 80px]. This
          // keeps the preview readable at extreme zooms (a 1m quad
          // can otherwise shrink to 2px from far away or fill the
          // canvas up close).
          const dx = c2.x - c0.x;
          const dy = c2.y - c0.y;
          const diag = Math.hypot(dx, dy) || 1;
          const minPx = 50;  // ~50px diagonal — visible but not
                             // overpowering
          const maxPx = 140;
          const scale = diag < minPx ? minPx / diag
                      : diag > maxPx ? maxPx / diag
                      : 1;
          const rescale = (c: { x: number; y: number }) => ({
            x: foot.x + (c.x - foot.x) * scale,
            y: foot.y + (c.y - foot.y) * scale,
          });
          setProj({
            quad: [rescale(c0), rescale(c1), rescale(c2), rescale(c3)],
            foot,
            tip,
          });
        }
      }
      raf = requestAnimationFrame(project);
    };
    project();
    return () => cancelAnimationFrame(raf);
  }, [preview.point, preview.normal, preview.faceKey]);

  if (!proj) return null;

  const { quad, foot, tip } = proj;
  // Arrow pixel length capped at 36px so it stays a small "telltale"
  // rather than visually competing with the quad. Direction comes
  // from the projected normal so it tracks camera orientation.
  const adx = tip.x - foot.x, ady = tip.y - foot.y;
  const aLen = Math.hypot(adx, ady) || 1;
  const ARROW_PX = Math.min(36, aLen);
  const tipX = foot.x + (adx / aLen) * ARROW_PX;
  const tipY = foot.y + (ady / aLen) * ARROW_PX;

  return (
    <g style={{ pointerEvents: 'none' }} aria-hidden data-section-pick-preview>
      {/* Translucent accent quad — the "you'll cut here" hint. */}
      <polygon
        points={quad.map((p) => `${p.x},${p.y}`).join(' ')}
        className="fill-overlay-accent-soft stroke-overlay-accent"
        strokeWidth="1.5"
      />
      {/* Tiny normal arrow — shaft. */}
      <line
        x1={foot.x} y1={foot.y}
        x2={tipX}   y2={tipY}
        className="stroke-overlay-accent"
        strokeWidth="2" strokeLinecap="round"
      />
      {/* Arrowhead — small triangle perpendicular to the shaft. */}
      <polygon
        points={(() => {
          const ux = adx / aLen, uy = ady / aLen;
          const nxp = -uy, nyp = ux;
          const baseX = tipX - ux * 6;
          const baseY = tipY - uy * 6;
          const ax = baseX + nxp * 4, ay = baseY + nyp * 4;
          const bx = baseX - nxp * 4, by = baseY - nyp * 4;
          return `${tipX},${tipY} ${ax},${ay} ${bx},${by}`;
        })()}
        className="fill-overlay-accent"
      />
    </g>
  );
}
