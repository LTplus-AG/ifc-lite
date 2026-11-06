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

  note(clip: PickClipState): void {
    const key = JSON.stringify([clip.sectionPlane, clip.extraPlanes, clip.clipBox, [...(clip.sectionExcludedIds ?? [])]]);
    if (key === this.key) return;
    this.key = key;
    this.revision++;
  }
}
