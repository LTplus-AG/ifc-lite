/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ReferenceCorners } from '@ifc-lite/renderer';
import type { ViewerState } from '@/store';
import { totalYupOffset } from '@/hooks/ingest/federationAlign';
import { placementFrameKey } from '@/lib/model-placement/persistence';
import { toRenderTranslation } from '@/lib/model-placement/translation';
import type { RegisteredAppearanceReference } from '../references/types.js';

type Registration = Pick<RegisteredAppearanceReference, 'cornersIfcWorld' | 'frameKey'>;

/** Existing placement keys include two renderer rebases which do not change the
 * engineering coordinate frame. Ignore ONLY those two fields; CRS, map conversion,
 * unit scale and rotation still have to match before reusing an absolute point. */
function engineeringFrame(key: string): string {
  if (!key.startsWith('{') || key.length > 8192) return key;
  try {
    const frame: unknown = JSON.parse(key);
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return key;
    const parsed = { ...frame } as Record<string, unknown>;
    if (!('crs' in parsed) || !('conversion' in parsed)) return key;
    delete parsed.originShift;
    delete parsed.rtc;
    return JSON.stringify(parsed);
  } catch (error) {
    // Imported malformed keys remain opaque mismatches. No coordinates are guessed.
    console.warn('[Appearance references] Invalid coordinate frame metadata:', error instanceof Error ? error.message : 'invalid JSON');
    return key;
  }
}

export function referenceFrameStatus(record: Registration, state: ViewerState): 'ready' | 'frame-mismatch' {
  const live = placementFrameKey(state);
  return record.frameKey === live || engineeringFrame(record.frameKey) === engineeringFrame(live) ? 'ready' : 'frame-mismatch';
}

/** Absolute IFC metre coordinates remain untouched; all four renderer points
 * are derived again after RTC/origin changes, retaining size and landmark position. */
export function referenceRenderCorners(record: Registration, state: ViewerState): ReferenceCorners | null {
  if (referenceFrameStatus(record, state) !== 'ready') return null;
  const anchor = [...state.models.values()].find(model => model.federationAlignmentStatus === 'anchor');
  const info = anchor?.geometryResult?.coordinateInfo ?? state.geometryResult?.coordinateInfo;
  const offset = totalYupOffset(info);
  const convert = (point: RegisteredAppearanceReference['cornersIfcWorld'][number]): readonly [number, number, number] => {
    const render = toRenderTranslation(point);
    return [render[0] - offset.x, render[1] - offset.y, render[2] - offset.z];
  };
  return [convert(record.cornersIfcWorld[0]), convert(record.cornersIfcWorld[1]), convert(record.cornersIfcWorld[2]), convert(record.cornersIfcWorld[3])];
}
