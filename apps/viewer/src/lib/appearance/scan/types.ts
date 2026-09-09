/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Consumed shape of the canonical Rust registration_types.rs contract. */
export type ScanPoint = [number, number, number];
export interface ScanFrame { assetSha256: string; frameKey: string }
export interface ScanCorrespondence {
  id: string; sourceObservation: string; targetFeature: string;
  source: ScanPoint; target: ScanPoint;
}
export interface ScanRegistrationRequest {
  sourceFrame: ScanFrame; targetFrame: ScanFrame;
  fit: ScanCorrespondence[]; heldOut: ScanCorrespondence[];
}
export interface ScanResiduals {
  points: { id: string; vectorMetres: ScanPoint; distanceMetres: number }[];
  rmsMetres: number | null; maxMetres: number | null;
}
export interface ScanRegistrationReport {
  requestSha256: string; algorithm: string;
  sourceFrame: ScanFrame; targetFrame: ScanFrame;
  rotation: [ScanPoint, ScanPoint, ScanPoint]; sourceAnchor: ScanPoint; targetAnchor: ScanPoint;
  sourceSpread: { singularValues: ScanPoint; nonCollinearityRatio: number; nonPlanarityRatio: number };
  targetSpread: ScanRegistrationReport['sourceSpread'];
  fit: ScanResiduals; heldOut: ScanResiduals; diagnostics: string[];
}
export interface ScanLandmark { point: ScanPoint; observation: string; triangle: number; barycentric: ScanPoint }
export interface ScanPair { correspondence: ScanCorrespondence; source: ScanLandmark; partition: 'fit' | 'check' }
