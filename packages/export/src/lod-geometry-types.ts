/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type Vec3 = [number, number, number];

export type LodInput = ArrayBuffer | Uint8Array;

export type Lod0Element = {
  expressID: number;
  globalId: string | null;
  ifcClass: string;
  name: string | null;
  /** Row-major 4x4 world matrix */
  transform: [
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
    number, number, number, number
  ];
  /** World-space axis-aligned bounding box */
  bbox: { min: Vec3; max: Vec3 };
  centroid: Vec3;
  /** Where bbox came from (required for fallback) */
  bbox_source: 'shape' | 'fallback';
};

export type Lod0Json = {
  schema: 'ifc-lite-geometry';
  lod: 0;
  units: 'm';
  elements: Lod0Element[];
  /** Elements refused rather than emitted (e.g. a `PlacementRelTo` cycle); absent when none. */
  skipped?: { expressID: number; reason: string }[];
};

export type Lod1MetaJson = {
  schema: 'ifc-lite-geometry';
  lod: 1;
  status: 'ok' | 'degraded';
  fallback?: 'boxes_from_lod0';
  failedElements: number[];
  notes: string[];
  /** expressID -> node/mesh mapping */
  mapping: Record<string, { node: number; mesh: number }>;
};

export type GenerateLod1Result = { glb: Uint8Array; meta: Lod1MetaJson };
