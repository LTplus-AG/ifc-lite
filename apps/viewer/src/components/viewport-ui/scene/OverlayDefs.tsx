/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared SVG `<defs>` for the scene overlay: one glow filter and two
 * arrowhead markers, defined once (#5486).
 *
 * Today four components each define their own copy of the same glow filter
 * (`SectionVisualization` `#section-glow`, `AddElementOverlay`
 * `#add-elem-glow`, `MeasurementVisuals` `#glow` and `#snap-glow`) — same
 * `feGaussianBlur` + merge, four ids. `OverlayDefs` PROVIDES the one shared
 * instance those four migrate onto — mounted once by `SceneOverlayRoot`,
 * referenced by `OVERLAY_GLOW_FILTER` / `OVERLAY_ARROWHEAD_ACCENT_MARKER` /
 * `OVERLAY_ARROWHEAD_INK_MARKER` instead of inventing a local id (a second
 * `<defs>` mounting the same id in the same document is undefined behaviour
 * — the browser picks one). This PR does NOT wire those four existing
 * components onto it; no consumers are migrated here (that's #5510-#5512).
 */

export const OVERLAY_GLOW_FILTER_ID = 'scene-overlay-glow';
export const OVERLAY_ARROWHEAD_ACCENT_ID = 'scene-overlay-arrowhead-accent';
export const OVERLAY_ARROWHEAD_INK_ID = 'scene-overlay-arrowhead-ink';

export const OVERLAY_GLOW_FILTER = `url(#${OVERLAY_GLOW_FILTER_ID})`;
export const OVERLAY_ARROWHEAD_ACCENT_MARKER = `url(#${OVERLAY_ARROWHEAD_ACCENT_ID})`;
export const OVERLAY_ARROWHEAD_INK_MARKER = `url(#${OVERLAY_ARROWHEAD_INK_ID})`;

/**
 * `markerUnits="userSpaceOnUse"` so the head stays a constant screen size
 * regardless of the stroke width of the line it terminates. A marker's
 * `<path>` does not inherit `fill`/`color` from the element that
 * REFERENCES it (`marker-end`) — SVG renders it as if it lived where it's
 * defined — so a shared, colour-agnostic marker needs `context-fill`
 * (patchy support) or, simplest and universally supported, one marker per
 * token colour actually used by a primitive today: accent (the thing being
 * dragged/measured live) and ink (finished/passive leaders and dimensions).
 */
function Arrowhead({ id, className }: { id: string; className: string }) {
  return (
    <marker id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" className={className} />
    </marker>
  );
}

export function OverlayDefs() {
  return (
    <defs>
      <filter id={OVERLAY_GLOW_FILTER_ID} x="-75%" y="-75%" width="250%" height="250%">
        <feGaussianBlur stdDeviation="3" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <Arrowhead id={OVERLAY_ARROWHEAD_ACCENT_ID} className="fill-overlay-accent" />
      <Arrowhead id={OVERLAY_ARROWHEAD_INK_ID} className="fill-overlay-ink" />
    </defs>
  );
}
