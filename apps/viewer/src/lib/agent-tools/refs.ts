/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef } from '@ifc-lite/sdk';
import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { effectiveGlobalIdLookup } from './effective.js';
import type { ReadyModel } from './types.js';

/**
 * The entity a call names, always scoped to the model the call was routed to.
 * A GlobalId is looked up in the effective entity set, so an entity the user
 * created in this session resolves and a deleted one does not.
 */
export function resolveRef(model: ReadyModel, args: Record<string, unknown>): EntityRef {
  if (typeof args.express_id === 'number') {
    return { modelId: model.id, expressId: args.express_id };
  }
  if (typeof args.global_id === 'string') {
    const id = effectiveGlobalIdLookup(model, args.global_id);
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
