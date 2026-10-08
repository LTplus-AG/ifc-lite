/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseGlobalIdTarget, parseLength, parsePoint } from './model-authoring-fields';
import type { AuthoringUnits, Point3, StoreyTarget } from './model-authoring';

export interface CopyFields {
  offset: Point3;
  angleDeg?: number;
  pivot?: [number, number];
  storey?: StoreyTarget;
  /** Optional pinned source placement in its storey-local frame. */
  from?: [number, number];
}
export interface ArrayFields {
  mode: 'linear' | 'polar';
  /** Includes the original; every new root has an explicit ref. */
  count: number;
  anchor: [number, number];
  cursor?: [number, number];
  distance?: number;
  fit?: boolean;
  angleDeg?: number;
  storey?: StoreyTarget;
  from?: [number, number];
}
const coordinate = { min: -10_000, max: 10_000, signed: true };
const delta = { min: -1_000, max: 1_000, signed: true };
function point(value: unknown, units: AuthoringUnits, at: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${at} must be [x, y] in ${units}`);
  return [parseLength(value[0], units, coordinate, at), parseLength(value[1], units, coordinate, at)];
}
function angle(value: unknown, at: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0 || Math.abs(value) > 360) throw new Error(`${at}: angleDeg must be nonzero finite degrees within ±360`);
  return value;
}
export function parseCopyFields(value: Record<string, unknown>, units: AuthoringUnits, at: string, array: false): CopyFields;
export function parseCopyFields(value: Record<string, unknown>, units: AuthoringUnits, at: string, array: true): ArrayFields;
export function parseCopyFields(value: Record<string, unknown>, units: AuthoringUnits, at: string, array: boolean): CopyFields | ArrayFields {
  const shared = {
    ...(value.storey === undefined ? {} : { storey: parseGlobalIdTarget(value.storey, `${at} storey`) }),
    ...(value.from === undefined ? {} : { from: point(value.from, units, `${at} from`) }),
  };
  const angleDeg = angle(value.angleDeg, at);
  if (!array) {
    const offset = parsePoint(value.offset, units, delta, `${at} offset`);
    const pivot = value.pivot === undefined ? undefined : point(value.pivot, units, `${at} pivot`);
    if (angleDeg !== undefined && !pivot) throw new Error(`${at}: a copy turn needs an explicit pivot`);
    if (pivot && angleDeg === undefined) throw new Error(`${at}: pivot needs angleDeg`);
    return { ...shared, offset, ...(angleDeg === undefined ? {} : { angleDeg, pivot }) };
  }
  if (value.mode !== 'linear' && value.mode !== 'polar') throw new Error(`${at}: array mode must be linear or polar`);
  // Bound receipts and synchronous review work more tightly than the native tool.
  if (typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 2 || value.count > 201) throw new Error(`${at}: count must be an integer from 2 to 201 including the original`);
  const anchor = point(value.anchor, units, `${at} anchor`);
  if (value.mode === 'polar') {
    if (value.cursor !== undefined || value.distance !== undefined || value.fit !== undefined) throw new Error(`${at}: polar arrays use anchor and angleDeg only`);
    return { ...shared, mode: 'polar', count: value.count, anchor, angleDeg: angleDeg ?? 360 };
  }
  if (angleDeg !== undefined) throw new Error(`${at}: linear arrays do not take angleDeg`);
  if (value.fit !== undefined && typeof value.fit !== 'boolean') throw new Error(`${at}: fit must be boolean`);
  return { ...shared, mode: 'linear', count: value.count, anchor, cursor: point(value.cursor, units, `${at} cursor`),
    ...(value.distance === undefined ? {} : { distance: parseLength(value.distance, units, { min: 0.001, max: 1_000 }, `${at} distance`) }),
    ...(typeof value.fit === 'boolean' ? { fit: value.fit } : {}) };
}
