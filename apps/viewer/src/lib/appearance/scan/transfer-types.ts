/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearanceRaster, PageAppearancePlan } from '../planner-types';
import type { ScanPoint, ScanRegistrationReport, ScanRegistrationRequest } from './types';
export interface TransferFrame { rotation: [ScanPoint, ScanPoint, ScanPoint]; sourceAnchor: ScanPoint; targetAnchor: ScanPoint }
/** How a point-cloud sample's facing side was decided; recorded on every plan (#4381). */
export type PointOrientation = 'source-normals' | 'viewpoints' | 'target-referenced';
export interface TransferSourceMesh {
  kind: 'mesh'; meshOrdinal: number; positions: ScanPoint[]; triangles: ScanPoint[]; uvs: [number, number][];
  baseColorFactor: [number, number, number, number]; repeatS: boolean; repeatT: boolean;
}
export interface TransferSourcePoints {
  kind: 'points'; pointCount: number; orientation: PointOrientation;
  neighborhoodRadiusMetres: number; minNeighbors: number; maxNeighbors: number; surfaceBandMetres: number;
  /** Scanner stations in source metres, indexed by the payload's per-point station; empty unless `viewpoints`. */
  viewpoints: ScanPoint[];
}
/** Binary companion of a `points` source: positions 3n f64 (source metres), RGB8 3n, optional oriented normals 3n and station indices n. */
export interface TransferPointPayload { positions: Float64Array; colors: Uint8Array; normals: Float32Array; stations: Uint32Array }
export interface MeshTransferRequest {
  schema: string; sourceRevision: string; nextExpressId: number; productIds: number[];
  registration: ScanRegistrationRequest; registrationSha256: string; targetFromIfcWorld: TransferFrame;
  source: TransferSourceMesh | TransferSourcePoints;
  /** The mesh source's decoded image inside the RGBA payload; absent for points. */
  sourceImage?: AppearanceRaster; sourceImages: Array<{ imageUri: string; raster: AppearanceRaster }>;
  texelsPerMetre: number; maxDistanceMetres: number; minNormalDot: number; ambiguityDistanceMetres: number;
  /** Same-facing observations deeper than this behind the IFC face stay unknown (thin-wall far side). */
  maxBehindMetres: number;
}
export interface TransferCoverage {
  centroidSamples: number; observedCentroidSamples: number; rasterInteriorTexels: number; observedRasterInteriorTexels: number;
  samples: number; observedSamples: number; unknownDistanceSamples: number; unknownNormalSamples: number; unknownAmbiguousSamples: number;
  unknownBehindSamples: number;
  /** Point sources only: too few supporting points for a local surface fit. */
  unknownSparseSamples: number;
  observedAreaEstimateM2: number; unknownAreaEstimateM2: number;
}
export interface TransferSourceSummary { kind: 'mesh' | 'points'; orientation: PointOrientation | null; pointCount: number | null }
export interface MeshTransferPlan extends Omit<PageAppearancePlan, 'plan'> {
  plan: PageAppearancePlan['plan'] | null;
  transfer: { preparedSha256: string; source: TransferSourceSummary; registrationSha256: string; registration: ScanRegistrationReport; applicable: boolean;
    coverage: TransferCoverage; items: (TransferCoverage & { productId: number; geometryItemId: number })[];
    exclusions: PageAppearancePlan['plan']['exclusions']; diagnostics: string[] };
}
