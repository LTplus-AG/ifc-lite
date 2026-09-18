/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ReferenceCorners } from '@ifc-lite/renderer';
import type { ViewerState } from '@/store';
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import { placementFrameKey, placementFrameCoordinateInfo, placementFrameBase, placementFrameFields } from '@/lib/model-placement/persistence';
import { toRenderTranslation } from '@/lib/model-placement/translation';
import type { RegisteredAppearanceReference } from '../references/types.js';

type Registration = Pick<RegisteredAppearanceReference, 'cornersIfcWorld' | 'frameKey'>;

/** Existing placement keys include two renderer rebases which do not change the
 * engineering coordinate frame. Ignore ONLY those two fields; CRS, map conversion,
 * unit scale and rotation still have to match before reusing an absolute point.
 *
 * `placementFrameKey` (`lib/model-placement/persistence.ts`) folds the live
 * RTC anchor into ONE JSON object as its `rtc` field; `placementFrameFields`
 * is the shared inverse that parses the key and drops `rtc` again. It is a
 * parse, never a string pattern (#4936 round 5 review): a pattern such as
 * `/:rtc:.*$/` also matched INSIDE a user-authored CRS name, truncating
 * `site:rtc:A` and `site:rtc:B` to the same prefix and reporting `ready` for
 * a reference registered in a different frame. Malformed keys are reported by
 * that helper and stay opaque mismatches; no coordinates are guessed. */
function engineeringFrame(key: string): string {
  const fields = placementFrameFields(key);
  if (!fields || !('crs' in fields) || !('conversion' in fields)) return placementFrameBase(key);
  delete fields.originShift;
  return JSON.stringify(fields);
}

export function referenceFrameStatus(record: Registration, state: ViewerState): 'ready' | 'frame-mismatch' {
  const live = placementFrameKey(state);
  return record.frameKey === live || engineeringFrame(record.frameKey) === engineeringFrame(live) ? 'ready' : 'frame-mismatch';
}

/** Absolute IFC metre coordinates remain untouched; all four renderer points
 * are derived again after RTC/origin changes, retaining size and landmark position. */
export function referenceRenderCorners(record: Registration, state: ViewerState): ReferenceCorners | null {
  if (referenceFrameStatus(record, state) !== 'ready') return null;
  const info = placementFrameCoordinateInfo(state);
  const offset = totalYupOffset(info);
  const convert = (point: RegisteredAppearanceReference['cornersIfcWorld'][number]): readonly [number, number, number] => {
    const render = toRenderTranslation(point);
    return [render[0] - offset.x, render[1] - offset.y, render[2] - offset.z];
  };
  return [convert(record.cornersIfcWorld[0]), convert(record.cornersIfcWorld[1]), convert(record.cornersIfcWorld[2]), convert(record.cornersIfcWorld[3])];
}
