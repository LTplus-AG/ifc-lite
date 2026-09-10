/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearanceRaster, PageAppearancePlan } from '../planner-types';
import type { ScanPoint, ScanRegistrationReport, ScanRegistrationRequest } from './types';
export interface TransferFrame { rotation: [ScanPoint, ScanPoint, ScanPoint]; sourceAnchor: ScanPoint; targetAnchor: ScanPoint }
export interface MeshTransferRequest {
  schema: string; sourceRevision: string; nextExpressId: number; productIds: number[];
  registration: ScanRegistrationRequest; registrationSha256: string; targetFromIfcWorld: TransferFrame;
  sourceMesh: { meshOrdinal: number; positions: ScanPoint[]; triangles: ScanPoint[]; uvs: [number, number][];
    baseColorFactor: [number, number, number, number]; repeatS: boolean; repeatT: boolean };
  sourceImage: AppearanceRaster; sourceImages: Array<{ imageUri: string; raster: AppearanceRaster }>;
  texelsPerMetre: number; maxDistanceMetres: number; minNormalDot: number; ambiguityDistanceMetres: number;
}
export interface TransferCoverage {
  centroidSamples: number; observedCentroidSamples: number; rasterInteriorTexels: number; observedRasterInteriorTexels: number;
  samples: number; observedSamples: number; unknownDistanceSamples: number; unknownNormalSamples: number; unknownAmbiguousSamples: number;
  observedAreaEstimateM2: number; unknownAreaEstimateM2: number;
}
export interface MeshTransferPlan extends Omit<PageAppearancePlan, 'plan'> {
  plan: PageAppearancePlan['plan'] | null;
  transfer: { preparedSha256: string; registrationSha256: string; registration: ScanRegistrationReport; applicable: boolean;
    coverage: TransferCoverage; items: (TransferCoverage & { productId: number; geometryItemId: number })[];
    exclusions: PageAppearancePlan['plan']['exclusions']; diagnostics: string[] };
}
