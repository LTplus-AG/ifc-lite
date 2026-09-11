/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AnnotationPlanePlan } from './planner-types';
export type AuthoredProductMesh = Omit<AnnotationPlanePlan['mesh'], 'uvs' | 'texture'> & {
  uvs?: number[];
  texture?: AnnotationPlanePlan['mesh']['texture'];
};
/** Canonical native geometry for one owner; operation-specific limits remain with its planner. */
export type AuthoredProductPlan = Pick<AnnotationPlanePlan, 'plan' | 'coordinateSpace' | 'rtcOffset'> & {
  objectId: number;
  meshes: readonly AuthoredProductMesh[];
};
