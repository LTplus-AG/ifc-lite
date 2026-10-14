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
 * What remains here is the tool's lifecycle: disarming the face pick on close
 * and never leaving a scan thinned after a scrub.
 */

import { useEffect } from 'react';
import { useViewerStore } from '@/store';
import { SectionPlaneVisualization } from './SectionVisualization';
import { SectionBoxVisualization } from './SectionBoxVisualization';
import { SectionHint } from './SectionHint';
import { startAlignmentTool } from '@/lib/section/alignment-controller';

export function SectionOverlay() {
  useEffect(startAlignmentTool, []);
  const sectionEnabled = useViewerStore((s) => s.sectionPlane.enabled);
  const setSectionPickMode = useViewerStore((s) => s.setSectionPickMode);
  const setPreviewStride = useViewerStore((s) => s.setPointCloudPreviewStride);

  // Reset the scan preview stride if the tool disappears mid-scrub (the user
  // closes the tool without releasing the distance field). Without this the
  // store can stay stuck at 4 and keep scans thinned indefinitely.
  useEffect(() => {
    return () => setPreviewStride(1);
  }, [setPreviewStride]);

  // Opening the tool changes nothing (#7545): the planes the user has are on
  // screen as they left them, and with none the bar offers the four ways to add
  // one. It used to re-apply the last cut or arm the face pick after 200 ms, so
  // the bar could open in a state nobody chose. Leaving the tool disarms a
  // pending pick, so it never survives into the next tool.
  useEffect(() => () => setSectionPickMode(false), [setSectionPickMode]);

  return (
    <>
      <SectionHint />

      {/* Section plane visualization overlay */}
      <SectionPlaneVisualization enabled={sectionEnabled} />
      <SectionBoxVisualization />
    </>
  );
}
