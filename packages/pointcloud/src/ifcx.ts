/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The IFCx point attribute decoders without the streaming sources and their Vite-only LAZ wasm asset. */

export type { IfcxPointSource } from './point-source.js';
export type { DecodedPointChunk, PointCloudBBox, PointNormalState } from './types.js';
export {
  POINTCLOUD_ATTR,
  POINTCLOUD_ATTR_KEYS,
  decodeIfcxPointAttribute,
  decodeIfcxPointSource,
} from './from-ifcx-attributes.js';
