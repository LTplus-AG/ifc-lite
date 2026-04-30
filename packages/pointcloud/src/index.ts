/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/pointcloud — renderer-agnostic point cloud decoders & types.
 *
 * Phase 0 covers the three IFCx schemas (`pcd::base64`, `points::array`,
 * `points::base64`). Subsequent phases add LAS/LAZ streaming, octrees, etc.
 */

export type { DecodedPointChunk, PointCloudBBox } from './types.js';
export { decodePcd } from './formats/pcd.js';
export {
  decodePointsArray,
  decodePointsBase64,
  type PointsArrayAttribute,
  type PointsBase64Attribute,
} from './formats/ifcx-points.js';
export { decompressLZF } from './lzf.js';
export {
  POINTCLOUD_ATTR,
  POINTCLOUD_ATTR_KEYS,
  decodeIfcxPointAttribute,
} from './from-ifcx-attributes.js';
