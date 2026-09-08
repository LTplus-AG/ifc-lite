/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit-frame conversion for an IDS property correction's WRITE side
 * (#3929 / #3943).
 *
 * The IDS facet's literal (and thus the value a user types to satisfy it)
 * is in base-SI, per the IDS spec — but the model stores every property in
 * its own raw, project-unit frame (`MutablePropertyView.setProperty`
 * applies no unit conversion). For a scalar measure (length/area/volume)
 * under a non-1.0 project unit scale, writing the base-SI value straight
 * through would corrupt the model: a `MinWidth >= 0.9` (metres) correction
 * typed as `0.9` under a millimetre project must be stored as `900`, not
 * `0.9`.
 *
 * `toRaw` is the inverse of the same `resolveEntityMeasureScales`-keyed
 * scaling `resolveEffectivePropertySets` (the bridge) uses to bring an
 * override back INTO base-SI for IDS re-validation — one shared scale
 * resolver, not two paths that can disagree. Non-measure dataTypes
 * (labels, booleans, identifiers) have no scale and `toRaw` passes them
 * through unchanged.
 */

import { resolveEntityMeasureScales, toRaw } from '@ifc-lite/ids/bridge';
import type { IfcDataStore } from '@ifc-lite/parser';

/**
 * Convert a user-typed, IDS-facing (base-SI) correction value into the
 * raw frame the model actually stores, for `expressId`'s own project
 * units and the target property's `dataType`.
 *
 * `toRaw` only ever returns `null` for a `null` input, and `value` here
 * is never `null` (callers parse it from user input, which throws rather
 * than producing one) — the cast reflects that, not a new assumption.
 */
export function scaleCorrectionForWrite(
  dataStore: IfcDataStore,
  expressId: number,
  dataType: string | undefined,
  value: string | number | boolean,
): string | number | boolean {
  const scales = resolveEntityMeasureScales(dataStore, expressId);
  return toRaw(value, dataType, scales) as string | number | boolean;
}
