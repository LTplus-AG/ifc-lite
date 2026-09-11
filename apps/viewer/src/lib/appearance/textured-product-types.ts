/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AnnotationPlanePlan } from './planner-types';

/** The shared commit boundary consumes canonical geometry and entity rows,
 * independent of whether the native planner created a drawing or a capture. */
export type TexturedProductPlan = Pick<AnnotationPlanePlan,
  'plan' | 'geometryItemId' | 'mesh' | 'coordinateSpace' | 'rtcOffset'> & { objectId: number };
