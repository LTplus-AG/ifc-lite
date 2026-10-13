/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NativeReviewCaptures, createNativeReviewIdentityTable, type NativeReviewModel } from '@ifc-lite/sdk/review';
import { modelAllowed, scopeAllows } from '../auth/scope.js';
import type { LoadedModel, ModelRegistry, ToolContext } from '../context.js';

// Registries are transport-session owned. Explicit principal/session keys also
// isolate hand-built servers that intentionally share a registry between callers.
const owners = new WeakMap<ModelRegistry, Map<string, NativeReviewCaptures>>();
export function reviewCaptures(ctx: ToolContext): NativeReviewCaptures {
  const key = JSON.stringify([ctx.session?.principal ?? ctx.scope.user ?? null, ctx.session?.id ?? null]);
  let sessions = owners.get(ctx.registry);
  if (!sessions) { sessions = new Map(); owners.set(ctx.registry, sessions); }
  let captures = sessions.get(key);
  if (!captures) {
    if (sessions.size >= 32) return new NativeReviewCaptures(0);
    captures = new NativeReviewCaptures(); sessions.set(key, captures);
  }
  return captures;
}

export function nativeReviewModel(model: LoadedModel): NativeReviewModel {
  return { id: model.id, name: model.name, owner: model, store: model.store, source: model.store.source,
    mutationView: () => model.backend.getMutationView(),
    identityTable: createNativeReviewIdentityTable(model.store),
    expressIdOf: GlobalId => model.store.entities.getExpressIdByGlobalId(GlobalId),
    globalIdOf: expressId => model.bim.entity({ modelId: model.id, expressId })?.globalId ?? '' };
}

/** Pin the call owner while reading live permissions and registry membership. */
export function reviewAccess(ctx: ToolContext, permission: 'read' | 'validate') {
  const principal = ctx.scope.user;
  const allowed = (id: string) => {
    const scope = ctx.currentScope?.() ?? ctx.scope;
    return scope.user === principal && scopeAllows(scope, permission) && modelAllowed(scope, id);
  };
  return { allowed, models: () => ctx.registry.list().filter(model => allowed(model.id)).map(nativeReviewModel) };
}
