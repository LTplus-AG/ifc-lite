/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Exact authored directrix in IFC Z-up, absolute-world metres. */
export type DirectrixSegment =
  | { type: 'line'; start: [number, number, number]; end: [number, number, number] }
  | {
      type: 'arc';
      center: [number, number, number];
      normal: [number, number, number];
      x_axis: [number, number, number];
      radius: number;
      start_angle: number;
      sweep_angle: number;
    };

/** A line has no bend angle; an arc reports its unsigned sweep in radians. */
export interface DirectrixSegmentMetrics {
  segment_index: number;
  length: number;
  bend_angle: number | null;
}

export interface DirectrixMetrics {
  total_length: number;
  segments: DirectrixSegmentMetrics[];
}

export interface SweptDiskOccurrence {
  solid_id: number;
  directrix_id: number;
  mapping_path: number[];
  /** The source solid is a CSG operand; the final visible result may differ. */
  source_modified: boolean;
  /** Effective world radius for complete records; authored radius in metres otherwise. */
  Radius: number;
  InnerRadius: number | null;
  Directrix: DirectrixSegment[];
  directrix_metrics: DirectrixMetrics | null;
  status: { type: 'complete' } | { type: 'unsupported'; reason: string };
}

/** Product STEP IDs are JavaScript object keys, so they are strings here. */
export interface SweptDiskDescriptions {
  up_axis: 'Z';
  units: 'm';
  coordinate_space: 'absolute_ifc_world';
  elements: Record<string, SweptDiskOccurrence[]>;
  diagnostics: string[];
}
