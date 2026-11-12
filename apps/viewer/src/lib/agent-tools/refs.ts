/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef } from '@ifc-lite/sdk';
import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { createGlobalIdResolver } from './effective.js';
import type { ReadyModel } from './types.js';

/**
 * The entity a call names, always scoped to the model the call was routed to.
 * A GlobalId is looked up in the effective entity set, so an entity the user
 * created in this session resolves and a deleted one does not. A tool that
 * resolves many GlobalIds passes one `createGlobalIdResolver(model)` for all of
 * them, so the overlay is read once per call rather than once per id.
 */
export function resolveRef(
  model: ReadyModel,
  args: Record<string, unknown>,
  lookup: (globalId: string) => number | undefined = createGlobalIdResolver(model),
): EntityRef {
  if (typeof args.express_id === 'number') {
    const expressId = args.express_id;
    if (!Number.isSafeInteger(expressId) || expressId <= 0) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'express_id must be a positive integer.' });
    }
    // `bim.entity` answers a made-up or deleted id with a placeholder, so
    // existence is checked here, once, for every tool that takes an id.
    if (!entityExists(model, expressId)) {
      throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `No entity #${expressId} in this model.` });
    }
    return { modelId: model.id, expressId };
  }
  if (typeof args.global_id === 'string') {
    const id = lookup(args.global_id);
    if (id !== undefined) return { modelId: model.id, expressId: id };
    throw new ToolExecutionError({
      code: ToolErrorCode.ENTITY_NOT_FOUND,
      message: `No entity with GlobalId '${args.global_id}' in this model.`,
    });
  }
  throw new ToolExecutionError({
    code: ToolErrorCode.INVALID_INPUT,
    message: 'Provide either global_id or express_id.',
  });
}

/**
 * A numeric argument as an integer in [min, max]: absent or not a finite
 * number gives `fallback`, a fraction is truncated, and both ends are
 * clamped (a negative limit would otherwise reach `slice` as "all but the
 * last N", and a huge one would be unbounded).
 */
export function integerArg(value: unknown, range: { min: number; max: number; fallback: number }): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return range.fallback;
  return Math.min(range.max, Math.max(range.min, Math.trunc(n)));
}

/**
 * Whether the entity is in the model as the user sees it: created this
 * session, or in the parsed file and not deleted. (`bim.entity` answers a
 * made-up id with a placeholder record, so it cannot tell.)
 */
export function entityExists(model: ReadyModel, expressId: number): boolean {
  const view = model.mutationView();
  if (view?.hasNewEntity(expressId)) return true;
  if (view?.isDeleted(expressId)) return false;
  return model.store.entityIndex.byId.get(expressId) !== undefined;
}

export function refStr(ref: EntityRef): string {
  return `#${ref.expressId} (model=${ref.modelId})`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

/** Every entity query a tool makes is pinned to its own model, so a federated session never mixes results. */
export function modelQuery(model: ReadyModel) {
  return model.bim.query().model(model.id);
}
