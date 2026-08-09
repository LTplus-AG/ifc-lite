/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared helpers used by tool handlers. Most importantly:
 *   - resolveModel(): pick the right LoadedModel given an optional model_id,
 *     erroring if none is loaded or the caller didn't pick when several are.
 *   - okResult(): build a standard CallToolResult with both human text and
 *     structuredContent.
 */

import { EntityNode } from '@ifc-lite/query';
import type { CallToolResult, ContentBlock } from '../protocol/index.js';
import type { LoadedModel, ToolContext } from '../context.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { modelAllowed } from '../auth/scope.js';
import { pendingOverlay } from '../overlay.js';

/**
 * Throw PERMISSION_DENIED when the caller's scope carries a model allowlist
 * that excludes `model`. Central guard so per-model access control is enforced
 * at the model-resolution choke point rather than per-tool.
 */
export function assertModelAccess(ctx: ToolContext, model: LoadedModel): LoadedModel {
  if (!modelAllowed(ctx.scope, model.id)) {
    throw new ToolExecutionError({
      code: ToolErrorCode.PERMISSION_DENIED,
      message: `Access to model '${model.id}' is not permitted for this token.`,
    });
  }
  return model;
}

/** Model IDs the caller's scope permits — never leak identifiers outside scope. */
function listAllowedModelIds(ctx: ToolContext): string[] {
  return ctx.registry.list().filter((m) => modelAllowed(ctx.scope, m.id)).map((m) => m.id);
}

export function resolveModel(ctx: ToolContext, modelId?: string): LoadedModel {
  if (ctx.registry.count() === 0) {
    throw new ToolExecutionError({
      code: ToolErrorCode.MODEL_NOT_FOUND,
      message: 'No models loaded. Call `model_load` first or start the server with a file path.',
    });
  }
  if (modelId) {
    const found = ctx.registry.get(modelId);
    if (!found) {
      throw new ToolExecutionError({
        code: ToolErrorCode.MODEL_NOT_FOUND,
        message: `Model '${modelId}' not loaded.`,
        details: { available: listAllowedModelIds(ctx) },
      });
    }
    return assertModelAccess(ctx, found);
  }
  if (ctx.registry.count() > 1) {
    throw new ToolExecutionError({
      code: ToolErrorCode.MODEL_REQUIRED,
      message: 'Multiple models loaded; pass `model_id` to pick one.',
      details: { available: ctx.registry.list().map((m) => m.id) },
    });
  }
  const only = ctx.registry.resolve();
  if (!only) throw new ToolExecutionError({ code: ToolErrorCode.MODEL_NOT_FOUND, message: 'No model available.' });
  return assertModelAccess(ctx, only);
}

/**
 * **The GlobalId precedence rule, defined once.**
 *
 * A `model_id` names a session, not a file, so resolving a GlobalId has to
 * include what `entity_create` queued and exclude what `entity_delete`
 * tombstoned (#2004). An agent that creates an entity and then addresses it by
 * the GlobalId it just wrote — to read it back, or to set a property on it — has
 * to reach it, and one that addresses an entity it deleted must not.
 *
 * **Queued entities come first.** They are few, and a re-GUID that reuses a
 * deleted entity's GlobalId should resolve to the live one. That order is not an
 * implementation detail: it is what `get_entity`, `entity_set_property`,
 * `entity_delete` and `bsdd_match` all answer with, so anything keyed by
 * GlobalId has to agree with it or the same identifier names two different
 * entities depending on which tool you asked (#2015).
 *
 * A GlobalId is supposed to be unique and in practice is not — a session can
 * create an entity under an id the file already uses, which is exactly what
 * `model_audit`'s `duplicate-globalid` rule reports. Both functions below apply
 * the same order; {@link resolveGlobalIds} additionally hands back the whole
 * carrier list, because a caller that asked by GlobalId and got one of two
 * entities deserves to be told rather than to guess.
 */

/** The expressId carrying `globalId` in this session, or null — the first entry
 *  {@link resolveGlobalIds} would list for it. Early-exits on the first match,
 *  which is why it is the single-lookup path; error policy is the caller's, so
 *  it returns null rather than throwing. */
export function findByGlobalId(model: LoadedModel, globalId: string): number | null {
  const overlay = pendingOverlay(model);
  for (const created of overlay?.created ?? []) {
    if (created.globalId === globalId) return created.expressId;
  }
  for (const [, ids] of model.store.entityIndex.byType) {
    for (const id of ids) {
      if (overlay?.deleted.has(id)) continue;
      if (new EntityNode(model.store, id).globalId === globalId) return id;
    }
  }
  return null;
}

/**
 * Every live carrier of each requested GlobalId, in the precedence above.
 *
 * One pass over the store for the whole request rather than one per key, which
 * is why bulk readers use this instead of calling {@link findByGlobalId} in a
 * loop. Keys with no carrier are absent from the result.
 */
export function resolveGlobalIds(model: LoadedModel, globalIds: Iterable<string>): Map<string, number[]> {
  const wanted = new Set(globalIds);
  const carriers = new Map<string, number[]>();
  if (wanted.size === 0) return carriers;
  const note = (globalId: string, expressId: number): void => {
    const list = carriers.get(globalId);
    if (list) list.push(expressId);
    else carriers.set(globalId, [expressId]);
  };
  const overlay = pendingOverlay(model);
  for (const created of overlay?.created ?? []) {
    if (wanted.has(created.globalId)) note(created.globalId, created.expressId);
  }
  for (const [, ids] of model.store.entityIndex.byType) {
    for (const id of ids) {
      if (overlay?.deleted.has(id)) continue;
      // A store entity's GlobalId is the one attribute no MCP write can change —
      // `entity_set_attribute` accepts Name/Description/ObjectType/Tag — so
      // reading it off the store is exact, not stale.
      const globalId = new EntityNode(model.store, id).globalId;
      if (wanted.has(globalId)) note(globalId, id);
    }
  }
  return carriers;
}

export function okResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  const content: ContentBlock[] = [{ type: 'text', text }];
  if (structured) {
    return { content, structuredContent: structured };
  }
  return { content };
}

export function fmtCount(n: number, singular: string, plural?: string): string {
  if (n === 1) return `1 ${singular}`;
  return `${n.toLocaleString()} ${plural ?? singular + 's'}`;
}

/** Slice a large array down to `limit` and return `{ items, truncated }`. */
export function paginate<T>(items: T[], limit: number, offset = 0): { items: T[]; truncated: boolean; total: number } {
  const total = items.length;
  const slice = items.slice(offset, offset + limit);
  return { items: slice, truncated: offset + limit < total, total };
}
