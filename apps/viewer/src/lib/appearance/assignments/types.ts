/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearanceQueryDefinition } from '../query-definition.js';
import type { AppearanceDraftSettings, AppearanceSourceOption } from '../draft-types.js';

/** Model slots remain explicit even when two loaded files have identical bytes. */
export interface AssignmentModel {
  slotId: string;
  modelId: string;
  name: string;
  sourceSha256: string;
  revision: string;
}
export interface AssignmentProduct {
  expressId: number;
  GlobalId: string;
}
export type AssignmentQuery =
  | { kind: 'model' }
  | { kind: 'selection'; GlobalIds: string[] }
  | { kind: 'class'; ifcClass: string }
  | { kind: 'type'; GlobalId: string }
  | { kind: 'filter'; query: AppearanceQueryDefinition };
export interface AppearanceAssignment {
  id: string;
  model: AssignmentModel;
  /** Original document/page/calibration and exact image derivative are frozen together. */
  source: Omit<AppearanceSourceOption, 'thumbnailUrl' | 'pdf'> & {
    pdf?: NonNullable<AppearanceSourceOption['pdf']> & { documentSha256?: string };
  };
  settings: AppearanceDraftSettings;
  query: AssignmentQuery;
  /** Reviewed query result, before explicit row exclusions and later-row overrides. */
  members: AssignmentProduct[];
  excludedGlobalIds: string[];
}
export interface AppearanceAssignmentRecipe {
  version: 1;
  assignments: AppearanceAssignment[];
}
export interface ResolvedAssignment {
  assignment: AppearanceAssignment;
  productIds: number[];
  excluded: number;
  overridden: number;
}
