/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AddStoreyParams, StoreyLevelEdit, StoreyDeleteMode, StoreyLevelPlan, StoreyDeletePlan, TopConstraint } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { operation, emptySchema, type OperationContext } from './contract';
import type { ToolHost } from '../types';
import { assertToolActive } from '../cancellation';
import { resolveRef } from '../refs';
import { evictOldest, retainCandidate } from './host-handles';
const outputSchema = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
const meta = (id: string, description: string, write = false) => ({ id, owner: 'model', description, effects: write ? ['model'] as const : ['read'] as const,
  capability: write ? 'commands-and-edits' as const : 'read' as const, implementation: 'sdk' as const, outputSchema, policy: write ? { model: 'native-reviewed' as const } : undefined });
type Params = { kind: 'add'; params: AddStoreyParams } | { kind: 'edit'; params: StoreyLevelEdit; plan: StoreyLevelPlan }
  | { kind: 'delete'; expressId: number; params: StoreyDeleteMode; plan: StoreyDeletePlan };
interface Candidate { data: Params; modelId: string; store: OperationContext['model']['store']; revision: number; result?: unknown }
const hosts = new WeakMap<ToolHost, Map<string, Candidate>>();
function owned(c: OperationContext) { let value = hosts.get(c.host); if (!value) { value = new Map(); hosts.set(c.host, value); } return value; }
function parse<T>(json: string): T { const value: unknown = JSON.parse(json); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('params_json must contain a canonical native parameter object.'); return value as T; }
export const storeyOperations = [
  operation(meta('storeys.read', 'Read all live native storey elevations, floor heights, element counts and constraints; source lengths are native metres.'), emptySchema, (_, c) => out(c.model.bim.store.listStoreyLevels(c.model.id))),
  operation<{ express_id: number; side: 'above' | 'below' }>(meta('storeys.suggest', 'Read the native naming/elevation suggestion above or below an explicit existing storey.'), {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 }, side: { type: 'string', enum: ['above', 'below'] } }, required: ['express_id', 'side'], additionalProperties: false,
  }, (i, c) => { const ref = resolveRef(c.model, { express_id: i.express_id }); return out(c.model.bim.store.suggestStorey(c.model.id, ref.expressId, i.side)); }),
  operation<{ kind: 'add' | 'edit' | 'delete'; express_id: number; params_json: string }>(meta('storeys.prepare', 'Use the authoritative native Storey planner for add, elevation/floor-height edit or delete. params_json uses AddStoreyParams, StoreyLevelEdit or StoreyDeleteMode; edit and delete name the storey in express_id, and an edit params storeyId must equal it; delete modes explicitly move contents or deleteContents. Returns the actual immutable native impact plan.'), {
    type: 'object', properties: { kind: { type: 'string', enum: ['add', 'edit', 'delete'] }, express_id: { type: 'integer', minimum: 0 }, params_json: { type: 'string', maxLength: 200000 } }, required: ['kind', 'express_id', 'params_json'], additionalProperties: false,
  }, (i, c) => {
    assertToolActive(c); let data: Params, preview: unknown;
    if (i.kind === 'add') { const params = parse<AddStoreyParams>(i.params_json); preview = c.model.bim.store.planAddStorey(c.model.id, params); data = { kind: 'add', params }; }
    else if (i.kind === 'edit') { const ref = resolveRef(c.model, { express_id: i.express_id }), params = parse<StoreyLevelEdit>(i.params_json);
      if (params.storeyId !== ref.expressId) throw new Error('params_json.storeyId must name the express_id storey.'); const plan = c.model.bim.store.planStoreyEdit(c.model.id, params); preview = plan; data = { kind: 'edit', params, plan }; }
    else { const ref = resolveRef(c.model, { express_id: i.express_id }), params = parse<StoreyDeleteMode>(i.params_json), plan = c.model.bim.store.planStoreyDelete(ref, params); preview = plan; data = { kind: 'delete', expressId: ref.expressId, params, plan }; }
    evictOldest(owned(c), 64); const token = crypto.randomUUID();
    retainCandidate(c, owned(c), token, { data: structuredClone(data), modelId: c.model.id, store: c.model.store, revision: useViewerStore.getState().mutationVersion });
    return out({ token, plan: preview });
  }),
  operation<{ token: string }>(meta('storeys.apply', 'Apply the exact prepared native Storey plan with its native expected-plan checks, transaction/constraint updates, remeshing and Undo. A candidate applies once.', true), {
    type: 'object', properties: { token: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['token'], additionalProperties: false,
  }, (i, c) => {
    const saved = owned(c).get(i.token); if (!saved || saved.modelId !== c.model.id || saved.store !== c.model.store) throw new Error('Unknown native Storey candidate.'); if (saved.result) return out(saved.result);
    if (saved.revision !== useViewerStore.getState().mutationVersion) throw new Error('Model changed after native Storey planning.');
    saved.result = c.commit(() => { const { data } = saved;
      if (data.kind === 'add') return c.model.bim.store.addStorey(c.model.id, data.params);
      if (data.kind === 'edit') return c.model.bim.store.editStorey(c.model.id, data.params, data.plan);
      return c.model.bim.store.deleteStorey({ modelId: c.model.id, expressId: data.expressId }, data.params, data.plan);
    }); return out(saved.result);
  }),
  operation<{ express_id: number; Name: string }>(meta('storeys.rename', 'Rename a validated storey through the native SDK transaction.', true), {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 }, Name: { type: 'string', minLength: 1, maxLength: 240 } }, required: ['express_id', 'Name'], additionalProperties: false,
  }, (i, c) => { const ref = resolveRef(c.model, { express_id: i.express_id }); return out(c.commit(() => c.model.bim.store.renameStorey(ref, i.Name))); }),
  operation<{ express_id: number; constraint_json: string }>(meta('storeys.topConstraint', 'Set an element top using the native TopConstraint contract (fixed/storeyAbove/storey/slab). Uses native authoritative attachment and dimension checks and native Undo.', true), {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 }, constraint_json: { type: 'string', maxLength: 200000 } }, required: ['express_id', 'constraint_json'], additionalProperties: false,
  }, (i, c) => { const ref = resolveRef(c.model, { express_id: i.express_id }), constraint = parse<TopConstraint>(i.constraint_json); return out(c.commit(() => c.model.bim.store.setTopConstraint(ref, constraint))); }),
];
