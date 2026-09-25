/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section tool's scene-side presence, the `section` row's `Scene` in
 * `TOOL_HUD` (#5499, charter #5478 §6); the row's `Bar` is `SectionToolbar`
 * (axis, flip, distance, Cap, Cut, 2D, close). This composes:
 *
 *  - `SectionHint` — the one hint line in the HUD's bottom-center region;
 *  - `SectionPlaneVisualization` — the face-picked plane's drag gizmo and
 *    the pick preview;
 *  - `SectionBoxVisualization` — the section box's faces and handles (#5513).
 *
 * What remains here is the tool's lifecycle: restoring the last-used mode
 * on open, disarming the face pick on close, and never leaving a scan
 * thinned after a scrub.
 */

import { useEffect } from 'react';
import { useViewerStore, loadLastSectionMode } from '@/store';
import { SectionPlaneVisualization } from './SectionVisualization';
import { SectionBoxVisualization } from './SectionBoxVisualization';
import { SectionHint } from './SectionHint';

export function SectionOverlay() {
  const sectionEnabled = useViewerStore((s) => s.sectionPlane.enabled);
  const setSectionPlaneAxis = useViewerStore((s) => s.setSectionPlaneAxis);
  const setSectionPlanePosition = useViewerStore((s) => s.setSectionPlanePosition);
  const flipSectionPlane = useViewerStore((s) => s.flipSectionPlane);
  const setSectionPickMode = useViewerStore((s) => s.setSectionPickMode);
  const setPreviewStride = useViewerStore((s) => s.setPointCloudPreviewStride);

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
  //   • 'box'      — a parked box resumes by itself (`section-active.ts`);
  //                  with no box left (a new file), arm the pick like a
  //                  first open (#5513).
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
    } else if (mode.kind === 'pick' || !useViewerStore.getState().sectionPlane.box) {
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
      <SectionHint />

      {/* Section plane visualization overlay */}
      <SectionPlaneVisualization enabled={sectionEnabled} />
      <SectionBoxVisualization />
    </>
  );
}
