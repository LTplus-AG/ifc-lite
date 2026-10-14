/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A cutting plane as `bim.viewer` reports and accepts it. */
export interface SectionPlane {
  axis: 'x' | 'y' | 'z';
  position: number;
  enabled: boolean;
  flipped: boolean;
  /** Set by `getSections()` and `addSection()`: names the plane for `removeSection(id)`. Ignored on input to `setSections()`. */
  id?: string;
  /** The plane's name in the viewer (A, B, C, or the user's own). Reported by `getSections()`; ignored on input, where the viewer names the planes it creates. */
  name?: string;
}
