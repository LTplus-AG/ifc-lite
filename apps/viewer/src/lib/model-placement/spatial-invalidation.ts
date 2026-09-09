/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { displayedTranslation } from './state';
import { equalTranslation } from './translation';

export function placementMoved(state: ViewerState, previous: ViewerState): boolean {
  return state.modelPlacement.frameKey !== previous.modelPlacement.frameKey || [...state.models.keys()].some((id) => !equalTranslation(
    displayedTranslation(state.modelPlacement, id), displayedTranslation(previous.modelPlacement, id)));
}

/** Measurements currently store workspace points without model anchors. Retain
 * them as historical annotations, but never present them as current geometry. */
export function staleMeasurementIds(state: ViewerState): ReadonlySet<string> {
  return new Set([...state.placementStaleMeasurements,
    ...state.measurements.map((item) => item.id), ...state.polylineMeasurements.map((item) => item.id),
    ...state.angleMeasurements.map((item) => item.id), ...state.radiusMeasurements.map((item) => item.id)]);
}
