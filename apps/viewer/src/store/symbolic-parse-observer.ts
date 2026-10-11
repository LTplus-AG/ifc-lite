/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Late binding avoids store → cache → store initialization cycles. Registering
 * the reader performs no top-level store read and starts no parse (#6537). */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { SymbolicParseOutcome } from '../hooks/symbolic-parse-outcomes.js';
import type { ViewerState } from './index.js';

interface Reader {
  epoch(): number;
  read(store: IfcDataStore, view: MutablePropertyView | undefined, mutationVersion: number): SymbolicParseOutcome;
}
let reader: Reader | undefined;
export function installSymbolicParseOutcomeReader(value: Reader): void { reader = value; }
export interface SymbolicParseCensus {
  readonly schema: 'symbolic-parse-outcomes-v1';
  readonly status: 'complete' | 'refused';
  readonly reason?: 'no-model' | 'model-budget' | 'incomplete-outcomes';
  readonly epoch: number;
  readonly models: readonly { readonly modelId: string; readonly outcome: SymbolicParseOutcome }[];
}

/** Current loaded models only; no list of weakly retained/evicted stores. */
export function readCurrentSymbolicParseCensus(
  state: Pick<ViewerState, 'models' | 'ifcDataStore' | 'mutationViews' | 'mutationVersion'>,
): SymbolicParseCensus {
  const epoch = reader?.epoch() ?? 0;
  const schema = 'symbolic-parse-outcomes-v1';
  if (state.models.size > 128) return { schema, status: 'refused', reason: 'model-budget', epoch, models: [] };
  const models: { modelId: string; outcome: SymbolicParseOutcome }[] = [];
  const add = (modelId: string, store: IfcDataStore, viewId: string): void => {
    models.push({ modelId, outcome: reader?.read(store, state.mutationViews.get(viewId), state.mutationVersion) ?? { phase: 'unobserved' } });
  };
  if (state.models.size > 0) {
    for (const [id, model] of state.models) {
      if (model.ifcDataStore) add(id, model.ifcDataStore, id);
      else models.push({ modelId: id, outcome: { phase: 'unobserved' } });
    }
  } else if (state.ifcDataStore) add('legacy', state.ifcDataStore, '__legacy__');
  if (models.length === 0) return { schema, status: 'refused', reason: 'no-model', epoch, models };
  const complete = models.every(({ outcome }) => outcome.phase === 'terminal'
    && (outcome.completion.kind === 'success' || outcome.completion.kind === 'skip')
    && outcome.census.status === 'complete');
  return { schema, status: complete ? 'complete' : 'refused', ...(complete ? {} : { reason: 'incomplete-outcomes' }), epoch, models };
}
