/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PickClipState } from './pick-types.js';

/**
 * Counts changes to the clip the pickers mirror from the last rendered frame.
 * render() re-snapshots that clip every frame, so its identity changes every
 * frame; a caller that must know whether a pick at a resting cursor could now
 * return something else (the viewer's Measure Point "Live" reading, #8886)
 * compares this revision instead.
 */
export class PickClipRevision {
  revision = 0;
  private key = '';
  private last = 0;
  /** The clip and revision before a run of transient (capture) frames. */
  private settled: { key: string; revision: number } | null = null;

  /**
   * `transient` marks a one-off capture frame (#9002), whose clip may be
   * cleared or swapped for that frame only. It still moves the revision, so a
   * pick made against its clip is told apart; the next normal frame that shows
   * the clip from before the capture returns to that frame's revision, so a
   * reading taken before the capture survives it. Any other clip is a change.
   */
  note(clip: PickClipState, transient = false): void {
    const key = JSON.stringify([clip.sectionPlane, clip.extraPlanes, clip.clipBox, [...(clip.sectionExcludedIds ?? [])]]);
    if (transient) this.settled ??= { key: this.key, revision: this.revision };
    else if (this.settled) {
      const settled = this.settled;
      this.settled = null;
      if (key === settled.key) {
        this.key = key;
        this.revision = settled.revision;
        return;
      }
    }
    if (key === this.key) return;
    this.key = key;
    this.revision = ++this.last;
  }
}
