/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerState } from '@/store';
import type { ModelAuthoringBatch } from './model-authoring';
import type { AuthoringReader } from './model-authoring-read';
import type { AuthoringRow } from './model-authoring-preview-types';
import { dryRunAuthoring } from './model-authoring-native';

/** The builders decide what static checks cannot: dimensions, hosts, joins, schema support. */
export function validateAuthoringDraft(state: ViewerState, batch: ModelAuthoringBatch, input: readonly AuthoringRow[], reader: (modelId: string) => AuthoringReader): void {
  for (const row of input) if (row.op.op === 'element.align' && row.modelId
    && input.some(other => other.index < row.index && other.modelId === row.modelId
      && other.status === 'ready' && !new Set<string>(['type.detach', 'classification.add']).has(other.op.op))) {
    row.status = 'unsupported';
    row.issue = 'Apply earlier same-model geometry operations before preparing native Align bounds';
  }
