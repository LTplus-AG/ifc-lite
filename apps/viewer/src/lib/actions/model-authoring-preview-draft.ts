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
  const byModel = new Map<string, AuthoringRow[]>();
  for (const row of input) if (row.status === 'ready' && row.modelId) byModel.set(row.modelId, [...(byModel.get(row.modelId) ?? []), row]);
  for (const [modelId, rows] of byModel) {
    const r = reader(modelId);
    const refusals = dryRunAuthoring(batch, r.dataStore, r.view, modelId, rows.map(({ index, op, resolved }) => ({ index, op, resolved })), { globalIdScopes: [...state.models].map(([id, model]) => ({ dataStore: model.ifcDataStore, view: state.mutationViews.get(id) })) }, state);
    for (const row of rows) {
      const refusal = refusals.get(row.index);
      if (refusal === undefined) continue;
      const blocked = row.dependsOn.some((i) => refusals.has(i));
      row.status = blocked ? 'blocked' : 'invalid';
      row.issue = blocked ? 'It needs an element another row creates, which the model refused' : refusal;
    }
  }
}

