/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The subset of the 3D Tiles 1.0 / 1.1 tileset JSON schema this reader consumes. */

export interface BoundingVolumeJson {
  /** [west, south, east, north, minHeight, maxHeight]; radians and metres, WGS84. Never transformed. */
  region?: number[];
  /** [cx, cy, cz, xAxis(3), yAxis(3), zAxis(3)]; axes carry the half-lengths. */
  box?: number[];
  /** [cx, cy, cz, radius]. */
  sphere?: number[];
  extensions?: Record<string, unknown>;
}

export interface ContentJson {
  uri?: string;
  /** Pre-1.0 spelling that some producers still emit. */
  url?: string;
  boundingVolume?: BoundingVolumeJson;
  group?: number;
  metadata?: unknown;
}

export interface TileJson {
  boundingVolume: BoundingVolumeJson;
  viewerRequestVolume?: BoundingVolumeJson;
  geometricError: number;
  refine?: string;
  /** Column-major 4x4, local -> parent. */
  transform?: number[];
  content?: ContentJson;
  /** 3D Tiles 1.1 multiple contents. */
  contents?: ContentJson[];
  children?: TileJson[];
  implicitTiling?: unknown;
  extensions?: Record<string, unknown>;
}

export interface TilesetJson {
  asset: { version: string; tilesetVersion?: string; [k: string]: unknown };
  geometricError: number;
  root: TileJson;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  properties?: Record<string, unknown>;
}
