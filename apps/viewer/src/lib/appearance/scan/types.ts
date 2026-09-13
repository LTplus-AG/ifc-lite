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
/** A picked scan observation: a barycentric point on a GLB triangle, or one
 * retained point of a streamed point cloud (#4381). `point` is in the source's
 * native frame; `observation` is its stable identity in that source. */
export type ScanLandmark = { point: ScanPoint; observation: string } & (
  | { kind: 'triangle'; triangle: number; barycentric: ScanPoint }
  | { kind: 'point'; index: number });
export interface ScanPair { correspondence: ScanCorrespondence; source: ScanLandmark; partition: 'fit' | 'check' }
