/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Typed entry to plane and cylinder detection in point clouds (#6870). The algorithm is
 * Rust (`ifc_lite_processing::scan_segmentation`); this module only frames
 * the input and types the JSON report the wasm call returns.
 *
 * Coordinates are metres in the frame of the supplied positions, plus
 * `options.origin` on output. The viewer's retained reservoir sample is Y-up
 * and decode-relative: pass `upAxis: [0, 1, 0]`.
 */
import type { IfcAPI } from '@ifc-lite/wasm';

export type ScanVec3 = [number, number, number];

/** Axis-aligned crop box in the positions' frame (inclusive). */
export interface ScanRegion {
  min: ScanVec3;
  max: ScanVec3;
}

/** Every field is optional; omitted fields take the Rust defaults below. */
export interface ScanSegmentationOptions {
  /** Averaging voxel edge. Default 0.03 m; 0.005..=1. */
  voxelSizeMetres?: number;
  /**
   * Voxel budget; past it the voxel size doubles. Default 1,500,000. Memory
   * is roughly 180 bytes per voxel: the 8,000,000 maximum (with 2 normal
   * rings) peaks near 1.4 GB, more than a browser tab should spend.
   */
  maxVoxels?: number;
  /** Normal neighbourhood: 1 = 26 neighbours (default), 2 = 124. */
  normalNeighborRings?: number;
  /** Occupied voxels (self included) a normal needs. Default 6. */
  minNeighbors?: number;
  /** Seed voxels have curvature at most this. Default 0.02. */
  maxSeedCurvature?: number;
  /** Growth and merge angle tolerance. Default 10 degrees. */
  maxNormalAngleDegrees?: number;
  /** Growth and merge distance tolerance. Default 0.02 m. */
  maxPlaneDistanceMetres?: number;
  /** Robust refit band in MADs. Default 2.5. */
  madScale?: number;
  /** Regions whose normals turn faster than this (1/radius) are curved. Default 1 per metre. */
  maxBendPerMetre?: number;
  /** Smaller planes are dropped. Default 0.25 m^2. */
  minPlaneAreaSquareMetres?: number;
  /** Horizontal / vertical classification tolerance. Default 10 degrees. */
  classificationAngleDegrees?: number;
  /** Up direction of the positions' frame. Default [0, 0, 1]. */
  upAxis?: ScanVec3;
  /** When given, every plane normal faces the scanner. */
  scannerPosition?: ScanVec3 | null;
  /** Added to every output coordinate. Default [0, 0, 0]. */
  origin?: ScanVec3;
  /** Only points inside this box take part. */
  region?: ScanRegion | null;
  /** Largest planes kept. Default 10,000. */
  maxPlanes?: number;
  /** Look for cylinders (columns, pipes) among non-planar voxels. Default true. */
  detectCylinders?: boolean;
  /** Accepted cylinder radius range. Default 0.03..=1.5 m. */
  minCylinderRadiusMetres?: number;
  maxCylinderRadiusMetres?: number;
  /** Share of a group a candidate must fit. Default 0.6. */
  minCylinderInlierFraction?: number;
  /** Minimum circumference covered. Default 90 degrees. */
  minCylinderArcDegrees?: number;
  /** Minimum length along the axis. Default 0.3 m. */
  minCylinderLengthMetres?: number;
  /** RANSAC draws per candidate. Default 256. */
  cylinderDraws?: number;
  /** Voxels each draw is scored on. Default 2,048. */
  cylinderScoreSample?: number;
  /** Largest non-planar groups examined. Default 1,024. */
  maxCylinderGroups?: number;
}

export type ScanPlaneOrientation = 'horizontal' | 'vertical' | 'sloped';
/** `scanner`: the normal faces `scannerPosition`. `canonical`: horizontal planes face up, others a fixed axis sign. */
export type ScanNormalSource = 'scanner' | 'canonical';

export interface ScanPlaneExtent {
  center: ScanVec3;
  uAxis: ScanVec3;
  vAxis: ScanVec3;
  uLength: number;
  vLength: number;
  corners: [ScanVec3, ScanVec3, ScanVec3, ScanVec3];
}

export interface ScanPlane {
  /** Unit normal; `normal . x + d = 0`. */
  normal: ScanVec3;
  d: number;
  centroid: ScanVec3;
  inlierPoints: number;
  inlierVoxels: number;
  areaSquareMetres: number;
  rmsMetres: number;
  extent: ScanPlaneExtent;
  orientation: ScanPlaneOrientation;
  normalSource: ScanNormalSource;
}

/** Axis relative to `upAxis`: vertical is a column, horizontal a pipe or beam. */
export type ScanAxisOrientation = 'vertical' | 'horizontal' | 'sloped';

export interface ScanCylinder {
  axisStart: ScanVec3;
  axisEnd: ScanVec3;
  /** Unit; points up unless horizontal. */
  axisDirection: ScanVec3;
  radius: number;
  length: number;
  /** Lowest and highest axis end along `upAxis`. */
  heightRange: [number, number];
  /** Circumference covered by the inliers, in degrees. */
  arcDegrees: number;
  inlierPoints: number;
  inlierVoxels: number;
  rmsMetres: number;
  orientation: ScanAxisOrientation;
}

export interface ScanSegmentationStats {
  inputPoints: number;
  acceptedPoints: number;
  rejectedPoints: number;
  outsideRegionPoints: number;
  /** f32 spacing at the largest coordinate: the finest resolution the positions carry. */
  coordinateSpacingMetres: number;
  voxelSizeMetres: number;
  coarsenings: number;
  voxels: number;
  voxelsWithNormals: number;
  seedVoxels: number;
  regionsGrown: number;
  regionsMerged: number;
  curvedRegionsRejected: number;
  smallRegionsRejected: number;
  planarVoxels: number;
  cylinderGroups: number;
  cylindersRejectedAsSpheres: number;
  cylindersRejectedAsCreases: number;
  cylindersRejectedForArc: number;
  cylindersRejectedForLength: number;
}

/** Which bounds acted; a bound that acts is always reported. */
export interface ScanSegmentationLimits {
  voxelBudgetCoarsened: boolean;
  planeLimitHit: boolean;
  /** Positions too far from their frame origin for the voxel size; pass a local `origin`. */
  coordinatePrecisionDegraded: boolean;
  cylinderGroupLimitHit: boolean;
}

export interface ScanSegmentationReport {
  algorithm: string;
  /** Largest area first. */
  planes: ScanPlane[];
  /** Longest first. */
  cylinders: ScanCylinder[];
  stats: ScanSegmentationStats;
  limits: ScanSegmentationLimits;
}

/**
 * xyz positions; `count` limits them to a prefix, so a reservoir whose buffer
 * is larger than its fill (the viewer's retained scan sample) passes as is.
 */
export interface ScanPointInput {
  positions: Float32Array;
  count?: number;
}

/** The wasm surface this needs: an initialised `IfcAPI` satisfies it. */
export type ScanSegmentationEngine = Pick<IfcAPI, 'segmentScanPoints'>;

/** Detect planes and cylinders in `input`. Throws the Rust error message on invalid options. */
export function segmentScan(
  engine: ScanSegmentationEngine,
  input: ScanPointInput,
  options: ScanSegmentationOptions = {},
): ScanSegmentationReport {
  const available = Math.floor(input.positions.length / 3);
  const count = input.count ?? available;
  if (!Number.isInteger(count) || count < 0 || count > available) {
    throw new RangeError(`Scan point count ${count} must be an integer within 0..${available}`);
  }
  const positions = count === available && input.positions.length === count * 3
    ? input.positions
    : input.positions.subarray(0, count * 3);
  const bytes = engine.segmentScanPoints(positions, JSON.stringify(options));
  return JSON.parse(new TextDecoder().decode(bytes)) as ScanSegmentationReport;
}
