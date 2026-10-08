/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Private native review contracts shared by preview, commit and ghosts. */
import type { ProfileSection } from '@ifc-lite/create';
import type { RowStatus } from './model-change-preview';
import type { AuthoringOp, ModelAuthoringBatch } from './model-authoring';
import type { ResolvedOp } from './model-authoring-native';
import type { ExpectedSize } from './model-authoring-size-params';
import type { ExpectedHostedEdit } from './model-authoring-hosted-edit';
import type { SplitSnapshot } from './model-authoring-split-state';

/** P04's statuses plus `invalid` (a native builder or planner refused it) and `blocked` (it needs a row that is not ready). */
export type AuthoringRowStatus = RowStatus | 'invalid' | 'blocked';

/** What the element is now, for the before → after summary. */
export interface AuthoringBefore {
  hosted?: ExpectedHostedEdit;
  split?: SplitSnapshot;
  size?: ExpectedSize;
  Profile?: ProfileSection;
  ifcClass?: string;
  name?: string;
  storeyName?: string;
  type?: string | null;
  material?: string | null;
  /** Placement origin in the storey, metres. */
  origin?: [number, number];
  angleDeg?: number;
}

export interface AuthoringRow {
  previewUnavailable?: boolean;
  previewOmitted?: string[];
  previewOuterBodyOnly?: boolean;
  index: number;
  op: AuthoringOp;
  status: AuthoringRowStatus;
  modelId: string | null;
  /** The existing element the operation acts on (the host for a hosted element), when it has one. */
  expressId: number | null;
  resolved: ResolvedOp;
  before: AuthoringBefore;
  /** Indices of the rows whose creations this one uses. */
  dependsOn: number[];
  /** Why the row is not ready: the native refusal, the expectation that failed, or the edit gate's reason. */
  issue?: string;
}

export interface ModelAuthoringPreview {
  batch: ModelAuthoringBatch;
  rows: AuthoringRow[];
  mutationVersion: number;
  digest: string;
}

