/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcSourceTransfer } from '@ifc-lite/parser';

/** Model-local identity, never a renderer/global selection ID. */
export interface AlignmentSectionBinding {
  modelId: string;
  expressId: number;
  geometricHorizontalDistanceMeters: number;
  geometricHorizontalLengthMeters: number;
}
export interface AlignmentAxisMetadata {
  expressId: number;
  GlobalId?: string;
  Name?: string;
  geometricHorizontalLengthMeters: number;
  approximate: boolean;
}
export interface AlignmentSectionSample {
  geometricHorizontalDistanceMeters: number;
  /** f64 absolute IFC Z-up world metres. */
  point: [number, number, number];
  tangent: [number, number, number];
}
export type AlignmentRequest =
  | { id: number; kind: 'open'; source: IfcSourceTransfer; expressId: number }
  | { id: number; kind: 'evaluate'; distance: number }
  | { id: number; kind: 'dispose' };
export type AlignmentResponse =
  | { id: number; ok: true; metadata: AlignmentAxisMetadata; sample: AlignmentSectionSample }
  | { id: number; ok: false; error: string };
