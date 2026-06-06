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

import type { CallToolResult, ContentBlock } from '../protocol/index.js';
import type { LoadedModel, ToolContext } from '../context.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { modelAllowed } from '../auth/scope.js';

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
