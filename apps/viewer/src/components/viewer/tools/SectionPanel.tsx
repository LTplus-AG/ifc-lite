/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section tool's scene-side presence, the `section` row's `Scene` in
 * `TOOL_HUD` (#5499, charter #5478 §6); the row's `Bar` is `SectionToolbar`
 * (axis, flip, distance, Cap, Cut, 2D, close). This composes:
 *
 *  - the bottom hint strip (moves to `HudHint` in #5500);
 *  - `SectionPlaneVisualization` — the corner badge (removed in #5500), the
 *    face-picked plane's drag gizmo and the pick preview.
 *
 * What remains here is the tool's lifecycle: restoring the last-used mode
 * on open, disarming the face pick on close, and never leaving a scan
 * thinned after a scrub.
 */

import { useEffect } from 'react';
import { useViewerStore, loadLastSectionMode } from '@/store';
import { AXIS_INFO } from './sectionConstants';
import { SectionPlaneVisualization } from './SectionVisualization';
import { useTranslation } from '@/i18n';

export function SectionOverlay() {
  const { t } = useTranslation();
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const setSectionPlaneAxis = useViewerStore((s) => s.setSectionPlaneAxis);
  const setSectionPlanePosition = useViewerStore((s) => s.setSectionPlanePosition);
  const flipSectionPlane = useViewerStore((s) => s.flipSectionPlane);
  const sectionPickMode = useViewerStore((s) => s.sectionPickMode);
  const setSectionPickMode = useViewerStore((s) => s.setSectionPickMode);
  const setPreviewStride = useViewerStore((s) => s.setPointCloudPreviewStride);
  const isCustom = sectionPlane.custom !== undefined;

  // Reset the scan preview stride if the tool disappears mid-scrub (the user
  // closes the tool without releasing the distance field). Without this the
  // store can stay stuck at 4 and keep scans thinned indefinitely.
  useEffect(() => {
    return () => setPreviewStride(1);
  }, [setPreviewStride]);

  // Restore the user's last-used section mode when the tool opens
  // (issue #243 follow-up). Two modes round-trip via localStorage:
  //
  //   • 'pick'     — face-pick is the default for first-time users and
  //                  anyone whose last action was a face pick. The 200ms
  //                  debounce stops the click that opened the tool from
  //                  bleeding through to the canvas pick handler and
  //                  accidentally sectioning the floor on the same frame
  //                  the bar mounts.
  //   • 'cardinal' — restore axis + position + flipped so the cut
  //                  appears exactly where the user left it. Section is
  //                  enabled by these setters so the cut is immediately
  //                  visible — matches the user's mental model of
  //                  "opening the tool where I left it".
  //
  // Cleanup disarms pick mode on unmount so leaving the tool doesn't
  // leave pick mode armed for the next tool.
  useEffect(() => {
    const mode = loadLastSectionMode();
    let armTimer: ReturnType<typeof setTimeout> | null = null;

    if (mode.kind === 'cardinal') {
      // Read current flipped via getState() so we don't pull the live
      // store value into the dep array (which would re-run the effect
      // every flip and clobber the restore on each interaction).
      const currentFlipped = useViewerStore.getState().sectionPlane.flipped;
      setSectionPlaneAxis(mode.axis);
      setSectionPlanePosition(mode.position);
      if (currentFlipped !== mode.flipped) flipSectionPlane();
    } else {
      armTimer = setTimeout(() => setSectionPickMode(true), 200);
    }

    return () => {
      if (armTimer !== null) clearTimeout(armTimer);
      setSectionPickMode(false);
    };
    // The setters are stable refs from zustand; flipSectionPlane reads
    // current state via getState() so it's intentionally NOT in the dep
    // array (would cause the restore to re-run on every flip).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSectionPickMode, setSectionPlaneAxis, setSectionPlanePosition, flipSectionPlane]);

  return (
    <>
      {/* Bottom hint strip (#5391). z-[45] keeps it above the 2D drawing
          window (z-40, docked bottom-left), which used to hide its left half.
          Becomes a `HudHint` in #5500. */}
      <div className="pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2 z-[45] flex items-center gap-2">
        <div
          data-section-hint
          className="whitespace-nowrap bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-3 py-1.5 border-2 border-zinc-900 dark:border-zinc-100 transition-shadow duration-150"
          style={{
            boxShadow: sectionPlane.enabled
              ? '4px 4px 0px 0px var(--overlay-accent)' // Interaction accent when active (#5488)
              : '3px 3px 0px 0px rgba(0,0,0,0.3)'
          }}
        >
          <span className="font-mono text-xs uppercase tracking-wide">
            {sectionPickMode
              ? t('sectionTool.hint.pick')
              : sectionPlane.enabled
                ? isCustom
                  ? t(sectionPlane.flipped ? 'sectionTool.hint.customFlipped' : 'sectionTool.hint.custom', {
                    distance: sectionPlane.custom!.distance.toFixed(2),
                  })
                  : t(sectionPlane.flipped
                    ? AXIS_INFO[sectionPlane.axis].flippedStatusKey
                    : AXIS_INFO[sectionPlane.axis].statusKey, { position: sectionPlane.position.toFixed(1) })
                : t('sectionTool.hint.off')}
          </span>
        </div>
      </div>

      {/* Section plane visualization overlay */}
      <SectionPlaneVisualization axis={sectionPlane.axis} enabled={sectionPlane.enabled} />
    </>
  );
}
