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
 * applies no unit conversion). For a measure (length, area, angle, ...)
 * under a non-1.0 project unit scale, writing the base-SI value straight
 * through would corrupt the model: a `MinWidth >= 0.9` (metres) correction
 * typed as `0.9` under a millimetre project must be stored as `900`, not
 * `0.9`.
 *
 * `propertyValueToRaw` is the inverse of the same conversion
 * `resolveEffectivePropertySets` (the bridge) uses to bring an override back
 * INTO base-SI for IDS re-validation — one shared resolver, not two paths
 * that can disagree. A property that declares its own `Unit` is stored in
 * that unit, not the project's (#7395). Non-measure dataTypes (labels,
 * booleans, identifiers) pass through unchanged.
 */

import { propertyValueToRaw } from '@ifc-lite/ids/bridge';
import type { IfcDataStore } from '@ifc-lite/parser';

/**
 * Convert a user-typed, IDS-facing (base-SI) correction value into the
 * raw frame the model actually stores for `psetName`.`propName` on
 * `expressId`: its own unit when it declares one, else the entity's
 * project unit for `dataType`.
 */
export function scaleCorrectionForWrite(
  dataStore: IfcDataStore,
  expressId: number,
  target: { psetName: string; propName: string },
  dataType: string | undefined,
  value: string | number | boolean,
): string | number | boolean {
  return propertyValueToRaw(dataStore, expressId, target.psetName, target.propName, dataType, value);
}
