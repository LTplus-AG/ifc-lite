/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adapter: given a node's attribute map (already composed by IFCx), pick
 * the appropriate decoder for the three buildingSMART point cloud schemas
 * and produce a DecodedPointChunk.
 *
 * Returns null if the node carries none of the supported attributes.
 */

import { decodePcd } from './formats/pcd.js';
import {
  decodePointsArray,
  decodePointsBase64,
  type PointsArrayAttribute,
  type PointsBase64Attribute,
} from './formats/ifcx-points.js';
import type { DecodedPointChunk } from './types.js';

export const POINTCLOUD_ATTR = {
  PCD_BASE64: 'pcd::base64',
  POINTS_ARRAY: 'points::array',
  POINTS_BASE64: 'points::base64',
} as const;

/** Set of attribute keys that signal a point cloud node. */
export const POINTCLOUD_ATTR_KEYS: ReadonlySet<string> = new Set(Object.values(POINTCLOUD_ATTR));

export function decodeIfcxPointAttribute(
  attributes: ReadonlyMap<string, unknown>
): DecodedPointChunk | null {
  const pcd = attributes.get(POINTCLOUD_ATTR.PCD_BASE64);
  if (typeof pcd === 'string' && pcd.length > 0) {
    return decodePcd(base64ToBytes(pcd));
  }
  const arr = attributes.get(POINTCLOUD_ATTR.POINTS_ARRAY);
  if (arr && typeof arr === 'object') {
    return decodePointsArray(arr as PointsArrayAttribute);
  }
  const b64 = attributes.get(POINTCLOUD_ATTR.POINTS_BASE64);
  if (b64 && typeof b64 === 'object') {
    return decodePointsBase64(b64 as PointsBase64Attribute);
  }
  return null;
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  const buf = (globalThis as unknown as { Buffer?: { from: (s: string, e: string) => Uint8Array } }).Buffer;
  if (buf && typeof buf.from === 'function') {
    return new Uint8Array(buf.from(b64, 'base64'));
  }
  throw new Error('No base64 decoder available in this environment');
}
