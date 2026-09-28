/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Identity includes the model and occurrence: STEP IDs can collide across models. */
export interface SelectedDirectrixSegment {
  modelId: string;
  expressId: number;
  occurrenceIndex: number;
  segmentIndex: number;
}

export function sameDirectrixSegment(
  a: SelectedDirectrixSegment | null,
  b: SelectedDirectrixSegment | null,
): boolean {
  return a === b || (!!a && !!b && a.modelId === b.modelId
    && a.expressId === b.expressId && a.occurrenceIndex === b.occurrenceIndex
    && a.segmentIndex === b.segmentIndex);
}
