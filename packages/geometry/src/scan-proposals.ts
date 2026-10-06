/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Typed entry to scan-to-BIM element proposals (#6894). The logic is Rust
 * (`ifc_lite_processing::scan_proposals`): opposite wall faces pair into
 * walls, floors and ceilings into slabs, vertical cylinders into columns and
 * the rest into pipes. This module only types the JSON the wasm call takes
 * and returns.
 *
 * Proposals are in the IFC model frame: Z up, metres. `scanToModel` maps the
 * segmentation report's frame into it; for the viewer's Y-up, decode-relative
 * scan sample that is the point cloud's placement composed with the Y-up to
 * Z-up swap and the model's world offset.
 */
import type { IfcAPI } from '@ifc-lite/wasm';
import type { ScanSegmentationReport, ScanVec3 } from './scan-segmentation.js';

export type ProposalSchema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

/** Every field is optional; omitted fields take the Rust defaults below. */
export interface ScanProposalOptions {
  /**
   * Row-major 4x4 similarity (rotation, uniform scale, translation) from the
   * report's frame to the IFC model frame. Default identity. Reflections and
   * non-uniform scale are refused.
   */
  scanToModel?: number[];
  /** Decides the pipe class: IfcFlowSegment in IFC2X3, else IfcPipeSegment. Default IFC4. */
  schema?: ProposalSchema;
  /** Horizontal / vertical tolerance in the model frame. Default 10 degrees. */
  classificationAngleDegrees?: number;
  /** Wall faces pair when parallel within this. Default 5 degrees. */
  pairingAngleDegrees?: number;
  /** Paired wall faces lie this far apart or more. Default 0.05 m. */
  minWallThicknessMetres?: number;
  /** ... and at most this far. Default 0.6 m. */
  maxWallThicknessMetres?: number;
  /** Thickness of a wall seen from one side, placed behind the scanned side. Default 0.2 m. */
  defaultWallThicknessMetres?: number;
  /** Paired faces overlap along the wall by this share of the shorter one. Default 0.5. */
  minWallOverlapFraction?: number;
  /** Shorter vertical faces are not walls. Default 0.5 m. */
  minWallLengthMetres?: number;
  /** Lower vertical faces are not walls. Default 1 m. */
  minWallHeightMetres?: number;
  /** Smaller horizontal planes are not slabs. Default 1 m^2. */
  minSlabAreaSquareMetres?: number;
  /** Thickness of a slab seen from one side. Default 0.2 m. */
  defaultSlabThicknessMetres?: number;
  /** A ceiling and the floor above pair into one slab when this close (and at least `minWallThicknessMetres` apart). Default 0.6 m. */
  maxSlabThicknessMetres?: number;
  /** Wall and column ends within this of a floor or ceiling extend to it. Default 0.3 m. */
  levelSnapMetres?: number;
  /** A point inside the scanned space (model frame). Default: area-weighted plane centroid. */
  interiorPoint?: ScanVec3 | null;
}

export type ProposalClass = 'IfcWall' | 'IfcSlab' | 'IfcColumn' | 'IfcPipeSegment' | 'IfcFlowSegment';

/** How the proposal was derived. */
export type ProposalBasis = 'pairedFaces' | 'singleFace' | 'floorCeilingPair' | 'floor' | 'ceiling' | 'cylinder';

/** An index into the segmentation report's `planes` or `cylinders`. */
export interface DetectionRef {
  kind: 'plane' | 'cylinder';
  index: number;
}

export interface ProposalFit {
  /** Inlier-weighted RMS of the sources' residuals. */
  rmsMetres: number;
  inlierPoints: number;
  inlierVoxels: number;
  /** Measured area of the sources (cylinders: arc x radius x length). */
  areaSquareMetres: number;
}

export type ProposalGeometry =
  /** Axis line on the wall's centre plane, at its base elevation. */
  | { kind: 'wall'; start: ScanVec3; end: ScanVec3; thicknessMetres: number; heightMetres: number }
  /** Top face outline, counter-clockwise from above; the slab extends `thicknessMetres` below. */
  | { kind: 'slab'; outline: ScanVec3[]; thicknessMetres: number }
  /** `radiusMetres`: the fitted radius; a polygonal column gets the circle of equal cross-section area. */
  | { kind: 'column'; base: ScanVec3; heightMetres: number; radiusMetres: number }
  | { kind: 'pipe'; start: ScanVec3; end: ScanVec3; radiusMetres: number };

export interface ScanElementProposal {
  /** Stable within one report: `wall-0`, `slab-2`, `column-1`, `pipe-0`. */
  id: string;
  ifcClass: ProposalClass;
  /** 0..1: prior(basis) x fit quality x coverage. */
  confidence: number;
  basis: ProposalBasis;
  sources: DetectionRef[];
  fit: ProposalFit;
  geometry: ProposalGeometry;
}

export interface ScanProposalStats {
  verticalPlanes: number;
  horizontalPlanes: number;
  slopedPlanes: number;
  pairedWalls: number;
  singleFaceWalls: number;
  facesTooSmall: number;
  pairedSlabs: number;
  singleSlabs: number;
  slabsTooSmall: number;
  columns: number;
  pipes: number;
}

export interface ScanProposalReport {
  algorithm: string;
  /** Walls, then slabs, columns and pipes; each class by descending support. */
  proposals: ScanElementProposal[];
  /** Uniform scale of `scanToModel`. */
  transformScale: number;
  stats: ScanProposalStats;
}

/** The wasm surface this needs: an initialised `IfcAPI` satisfies it. */
export type ScanProposalEngine = Pick<IfcAPI, 'proposeScanElements'>;

/** Propose IFC elements from `report`. Throws the Rust error message on invalid options. */
export function proposeScanElements(
  engine: ScanProposalEngine,
  report: ScanSegmentationReport,
  options: ScanProposalOptions = {},
): ScanProposalReport {
  if (options.scanToModel && options.scanToModel.length !== 16) {
    throw new RangeError(`scanToModel needs 16 row-major values, got ${options.scanToModel.length}`);
  }
  const bytes = engine.proposeScanElements(JSON.stringify(report), JSON.stringify(options));
  return JSON.parse(new TextDecoder().decode(bytes)) as ScanProposalReport;
}
