/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Give the user's section cut back when the BCF panel closes (#5829).
 *
 * Activating a viewpoint shows its clipping plane, or clears the cut when it
 * has none (`useBCF.applyViewpoint`, #4910). Nothing remembered the cut the
 * user had before, so reviewing a few topics silently replaced it for good.
 * This records the section state before the FIRST viewpoint the panel
 * applies, and the state each viewpoint left behind. On close it puts the
 * user's cut back, but only when the section is still what the last
 * viewpoint made it: a cut the user moved meanwhile is theirs, not ours.
 */

import type { SectionPlane } from '@/store/types';

interface SectionState {
  sectionPlane: SectionPlane;
  activeTool: string;
}

interface Snapshot {
  /** The user's section before the first viewpoint. */
  plane: SectionPlane;
  tool: string;
  /** The section as the most recent viewpoint left it. */
  applied: SectionPlane;
}

/** The cut's geometry; `enabled` / `parked` follow the active tool, not the user's choice of cut. */
function sameCut(a: SectionPlane, b: SectionPlane): boolean {
  return a.axis === b.axis && a.position === b.position && a.flipped === b.flipped
    && (a.enabled || !!a.parked) === (b.enabled || !!b.parked)
    && JSON.stringify(a.custom ?? null) === JSON.stringify(b.custom ?? null);
}

/** One hook's section history; only opt-in callers record a viewpoint. */
export class SectionRestoreSession {
  private snapshot: Snapshot | null = null;

  /** Remember the user's cut once, before this panel applies its first viewpoint. */
  noteBeforeViewpoint(state: SectionState): void {
    if (!this.snapshot) this.snapshot = { plane: state.sectionPlane, tool: state.activeTool, applied: state.sectionPlane };
  }

  noteAfterViewpoint(state: SectionState): void {
    if (this.snapshot) this.snapshot.applied = state.sectionPlane;
  }

  /** Restore only if the current cut still matches this panel's last viewpoint. */
  restore(
    getState: () => SectionState & { setActiveTool: (tool: string) => void },
    setState: (partial: { sectionPlane: SectionPlane }) => void,
  ): boolean {
    const snap = this.snapshot;
    this.snapshot = null;
    if (!snap) return false;
    const state = getState();
    if (!sameCut(state.sectionPlane, snap.applied)) return false;
    // Leave the Section tool only if a viewpoint opened it; the store parks or
    // resumes the restored cut for whichever tool ends up active.
    if (state.activeTool === 'section' && snap.tool !== 'section') state.setActiveTool(snap.tool);
    setState({ sectionPlane: snap.plane });
    return true;
  }
}
