/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { ifcToViewerAxes, totalYupOffset } from '../lib/geo/coordinate-frame.js';
import { useViewerStore } from '@/store';
import type { ElevationRebase } from '../lib/overlay-parse/symbolic-parse.js';

/**
 * The render-frame elevation offsets for the model that owns `store`.
 *
 * `totalYupOffset(info).y` is `originShift.y + rtc.z` — the whole distance
 * between an IFC elevation and the renderer's Y (`lib/geo/ifc-origin.ts`).
 * The wasm extractor has already removed the `rtc.z` half from
 * `primitive.worldY` (`rust/processing/src/symbolic/rebase.rs`), so only the
 * remainder applies there, while a raw storey-table elevation needs all of
 * it. Derived from ONE offset read so the two cannot drift apart.
 *
 * Read once per parse and baked into the cached `ParseResult`. Unlike the RTC
 * subtraction the wasm walk bakes into the same primitives, this is NOT a
 * function of the source bytes — RTC is derived from the model's own
 * coordinates, while `totalYupOffset` also carries `originShift`, which
 * federation and re-alignment set per model. That is why `sourceKey` mixes
 * these two values into the parse-cache key rather than keying on
 * `contentKey` alone.
 */
export function elevationRebaseFor(store: IfcDataStore): ElevationRebase {
  const state = useViewerStore.getState();
  let info: CoordinateInfo | null = null;
  let ownedByModel = false;
  for (const [, model] of state.models) {
    if (model.ifcDataStore !== store) continue;
    ownedByModel = true;
    info = model.geometryResult?.coordinateInfo ?? null;
    break;
  }
  if (!ownedByModel && state.ifcDataStore === store) info = state.geometryResult?.coordinateInfo ?? null;
  const total = totalYupOffset(info ?? undefined).y;
  const rtcYupY = ifcToViewerAxes(info?.wasmRtcOffset ?? { x: 0, y: 0, z: 0 }).y;
  return { primitive: total - rtcYupY, storeyTable: total };
}
