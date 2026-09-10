/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AnnotationPlanePlan, AnnotationPlaneRequest } from '../planner-types';
import type { PdfVectorPage } from './vector-types';
export interface PdfFillAnnotationRequest extends Omit<AnnotationPlaneRequest, 'imageUri'> {
  page: PdfVectorPage;
}
export type PdfFillAnnotationMesh = Omit<AnnotationPlanePlan['mesh'], 'uvs' | 'texture'> & {
  uvs?: never; texture?: never;
};
export interface PdfFillAnnotationPlan extends Pick<AnnotationPlanePlan,
  'plan' | 'annotationId' | 'coordinateSpace' | 'rtcOffset' | 'frame'> {
  meshes: PdfFillAnnotationMesh[];
  sourceIfcSha256: string; sourcePdfSha256: string; pageNumber: number;
  requestSha256: string; algorithm: 'ifclite-pdf-fill-annotation-v1';
  calibrationKey: string; toleranceMetres: number; gridSizeMetres: number; geometryWork: number;
  regions: Array<{ geometryItemId: number; sourceOperatorOrdinal: number; rgb: [number, number, number] }>;
}
