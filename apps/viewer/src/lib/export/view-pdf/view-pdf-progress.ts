/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The generator's stage ids as words a user recognises (#2042).
 *
 * It lives next to the export rather than in the dialog because the vocabulary
 * is the PIPELINE's, not the dialog's: `Drawing2DGenerator` and the shading
 * pass emit these ids, so a new stage added there is a missing label here. An
 * unmapped id deliberately falls through to a plain "Working" and never to a
 * raw internal identifier on screen.
 */
const PHASE_LABEL: Record<string, string> = {
  cutting: 'Cutting',
  polygons: 'Building outlines',
  edges: 'Finding edges',
  hidden: 'Removing hidden lines',
  merging: 'Merging lines',
  complete: 'Writing PDF',
  shading: 'Shading surfaces',
  encoding: 'Encoding image',
};

export function viewPdfPhaseLabel(stage: string): string {
  return PHASE_LABEL[stage] ?? 'Working';
}
