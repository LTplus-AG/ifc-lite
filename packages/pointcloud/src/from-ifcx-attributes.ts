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

import { decodePcd, decodePcdSource } from './formats/pcd.js';
import {
  decodePointsArray,
  decodePointsArraySource,
  decodePointsBase64,
  decodePointsBase64Source,
  type PointsArrayAttribute,
  type PointsBase64Attribute,
} from './formats/ifcx-points.js';
import type { IfcxPointSource } from './point-source.js';
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
  return decodeAttribute(attributes, decodePcd, decodePointsArray, decodePointsBase64);
}

/** Same precedence and errors as decodeIfcxPointAttribute, before float32 staging. */
export function decodeIfcxPointSource(attributes: ReadonlyMap<string, unknown>): IfcxPointSource | null {
  return decodeAttribute(attributes, decodePcdSource, decodePointsArraySource, decodePointsBase64Source);
}

function decodeAttribute<T>(
  attributes: ReadonlyMap<string, unknown>,
  pcdDecoder: (bytes: Uint8Array) => T,
  arrayDecoder: (attr: PointsArrayAttribute) => T,
  base64Decoder: (attr: PointsBase64Attribute) => T,
): T | null {
  const pcd = attributes.get(POINTCLOUD_ATTR.PCD_BASE64);
  if (typeof pcd === 'string' && pcd.length > 0) {
    return pcdDecoder(base64ToBytes(pcd));
  }
  const arr = attributes.get(POINTCLOUD_ATTR.POINTS_ARRAY);
  if (arr && typeof arr === 'object') {
    return arrayDecoder(arr as PointsArrayAttribute);
  }
  const b64 = attributes.get(POINTCLOUD_ATTR.POINTS_BASE64);
  if (b64 && typeof b64 === 'object') {
    return base64Decoder(b64 as PointsBase64Attribute);
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
