/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { entityForPath, pathForEntity } from './entity-paths';

const PATH_KEY = 'ifc-lite::entityPath';
const STEP_REFERENCE = /^#([1-9]\d*)$/;

export function referencedExpressIds(value: unknown, ids = new Set<number>()): Set<number> {
  if (typeof value === 'string') {
    const match = STEP_REFERENCE.exec(value);
    if (match) ids.add(Number(match[1]));
  } else if (Array.isArray(value)) {
    for (const item of value) referencedExpressIds(item, ids);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) referencedExpressIds(item, ids);
  }
  return ids;
}

/** Replace sender-local STEP references with stable room paths. */
export function encodeRoomAttributeValue(store: IfcDataStore, value: unknown): unknown {
  if (typeof value === 'string') {
    const match = STEP_REFERENCE.exec(value);
    if (!match) return value;
    const path = pathForEntity(store, Number(match[1]));
    return path ? { [PATH_KEY]: path } : value;
  }
  if (Array.isArray(value)) return value.map(item => encodeRoomAttributeValue(store, item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeRoomAttributeValue(store, item)]));
  }
  return value;
}

/** Resolve stable room paths into this recipient's local STEP ID space. */
export function decodeRoomAttributeValue(store: IfcDataStore, value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (Array.isArray(value)) {
    const decoded: unknown[] = [];
    for (const item of value) {
      const result = decodeRoomAttributeValue(store, item);
      if (!result.ok) return result;
      decoded.push(result.value);
    }
    return { ok: true, value: decoded };
  }
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && PATH_KEY in value) {
    const path = (value as Record<string, unknown>)[PATH_KEY];
    if (typeof path !== 'string') return { ok: false };
    const id = entityForPath(store, path);
    return id === null ? { ok: false } : { ok: true, value: `#${id}` };
  }
  if (value && typeof value === 'object') {
    const decoded: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = decodeRoomAttributeValue(store, item);
      if (!result.ok) return result;
      decoded[key] = result.value;
    }
    return { ok: true, value: decoded };
  }
  return { ok: true, value };
}
