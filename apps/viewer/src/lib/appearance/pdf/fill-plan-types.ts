/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AnnotationPlanePlan, AnnotationPlaneRequest } from '../planner-types';
import type { PdfFidelityReport, PdfVectorPage } from './vector-types';
export interface PdfFillAnnotationRequest extends Omit<AnnotationPlaneRequest, 'imageUri'> {
  /** Host-owned GlobalIds for the provenance property set and its relationship. */
  propertySetGlobalId: string;
  propertyRelationGlobalId: string;
  page: PdfVectorPage;
  /** Digest of the fidelity report the user accepted; required unless the page is exact. */
  acceptedFidelitySha256: string | null;
}
export type PdfFillAnnotationMesh = Omit<AnnotationPlanePlan['mesh'], 'uvs' | 'texture'> & {
  uvs?: never; texture?: never;
};
export interface PdfFillAnnotationPlan extends Pick<AnnotationPlanePlan,
  'plan' | 'annotationId' | 'coordinateSpace' | 'rtcOffset' | 'frame'> {
  propertySetId: number;
  meshes: PdfFillAnnotationMesh[];
  sourceIfcSha256: string; sourcePdfSha256: string; pageNumber: number;
  requestSha256: string; algorithm: 'ifclite-pdf-fill-annotation-v1';
  calibrationKey: string; toleranceMetres: number; gridSizeMetres: number; geometryWork: number;
  regions: Array<{ geometryItemId: number; sourceOperatorOrdinal: number; rgb: [number, number, number] }>;
  fidelity: PdfFidelityReport;
}
