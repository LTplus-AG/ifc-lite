/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How the main viewer writes an agent's edit (#9523): through the same
 * reviewed-change path the assistant's approved changes take
 * (`previewModelChanges` then `commitModelChanges`, which runs the store's
 * gated actions inside `runTransaction`). So every agent call is:
 *
 *   - checked by the viewer's own edit gate (edit mode, collaboration role,
 *     an editable model), exactly as a user edit is;
 *   - compared against the value the model holds now, and refused when it
 *     differs from what the agent says it read (`expected`);
 *   - one undo batch, rolled back whole if any write throws, and labelled in
 *     the Changes panel as the agent's.
 *
 * It only touches the session's pending-edit overlay. Nothing here saves,
 * exports or writes back to a cloud source; that stays a user action.
 */

import type { StoreApi } from 'zustand';
import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { parseModelChangeBatch, type ModelChange, type ModelChangeBatch } from '@ifc-lite/ai/artifacts';
import { resolveGlobalId, type GlobalIdTarget } from '@/lib/actions/resolve-global-id';
import type { ViewerState } from '@/store';
import { mutationDenial } from '@/store/mutation-permission';
import { previewModelChanges } from '@/lib/actions/model-change-preview';
import { changeField, commitModelChanges } from '@/lib/actions/model-change-commit';
import { currentValue, modelReader, UNSUPPORTED_VALUE } from '@/lib/actions/model-change-values';
import { labelAgentChange } from '@/lib/changes/agent-change-labels';
import { formatEditValue } from './edit-tools.js';
import type { AgentEdit, AgentEditRequest, ModelEditor, ReadyModel } from './types.js';

/** The `origin` the commit records for an agent's change. */
export const AGENT_EDIT_ORIGIN = 'agent-bridge';

function refuse(code: (typeof ToolErrorCode)[keyof typeof ToolErrorCode], message: string, details?: Record<string, unknown>): never {
  throw new ToolExecutionError({ code, message, ...(details ? { details } : {}) });
}

/** The request as a reviewed change; the batch parser does the bounds checks (text length, GlobalId, dataType). */
function asChange(request: AgentEditRequest, target: GlobalIdTarget, expected: unknown): unknown {
  switch (request.op) {
    case 'property.set':
      return { op: request.op, target, pset: request.pset, name: request.name, expected, value: request.value,
        ...(request.dataType !== undefined ? { dataType: request.dataType } : {}) };
    case 'property.delete':
      return { op: request.op, target, pset: request.pset, name: request.name, expected };
    case 'attribute.set':
      // An attribute that is not set reads as empty text, so `expected: null` means ''.
      return { op: request.op, target, name: request.name, expected: expected ?? '', value: request.value };
  }
}

function parseOne(tool: string, change: unknown): ModelChangeBatch {
  try {
    return parseModelChangeBatch(JSON.stringify({ version: 1, kind: 'model.changes', title: `Agent: ${tool}`, changes: [change] }));
  } catch (err) {
    return refuse(ToolErrorCode.INVALID_INPUT, err instanceof Error ? err.message.replace(/^Change 1 /, 'The edit ') : String(err));
  }
}

export function createMainViewerEditor(store: StoreApi<ViewerState>): ModelEditor {
  return {
    apply(model: ReadyModel, expressId: number, request: AgentEditRequest, tool: string): AgentEdit {
      const state = store.getState();
      // The legacy single-model path has no federated entry for the commit to resolve against.
      if (!state.models.has(model.id)) refuse(ToolErrorCode.UNSUPPORTED_OPERATION, `Model '${model.name}' cannot be edited by an agent.`);
      const entity = model.bim.entity({ modelId: model.id, expressId });
      if (!entity?.globalId) {
        refuse(ToolErrorCode.UNSUPPORTED_OPERATION, `#${expressId} has no GlobalId, so the viewer cannot edit it for an agent.`);
      }
      const target: GlobalIdTarget = { globalId: entity.globalId, modelId: model.id };
      // The edit gate first, so every refused edit says why the same way.
      const denial = mutationDenial(state, model.id);
      if (denial) refuse(ToolErrorCode.PERMISSION_DENIED, `The viewer does not allow editing this model now: ${denial}.`);
      // The commit addresses the entity by GlobalId, resolved exactly as here (same resolver, same
      // tick). A GlobalId shared with another entity of the model may resolve to that one, and the
      // write would land there: refuse instead.
      const resolved = resolveGlobalId(state, target);
      if (typeof resolved === 'object' && resolved.expressId !== expressId) {
        refuse(ToolErrorCode.ENTITY_NOT_FOUND,
          `GlobalId ${entity.globalId} is not unique in model '${model.name}' (#${resolved.expressId} also holds it), so #${expressId} cannot be edited by an agent.`,
          { globalId: entity.globalId, expressIds: [expressId, resolved.expressId] });
      }
      const reader = modelReader(state, model.id);
      if (!reader) refuse(ToolErrorCode.MODEL_NOT_FOUND, `Model '${model.name}' is not loaded.`);

      // Only op, set and name are read from the probe; the real change is validated below.
      const probe = asChange(request, target, null) as ModelChange;
      const field = changeField(probe);
      const current = currentValue(reader, expressId, probe);
      if (current === UNSUPPORTED_VALUE) {
        refuse(ToolErrorCode.UNSUPPORTED_OPERATION, `${field} holds a value agent edits cannot read or write (a list or a reference).`);
      }
      const given = 'expected' in request;
      // Nothing to delete and no expected value to compare.
      if (request.op === 'property.delete' && current === null && !given) {
        refuse(ToolErrorCode.INVALID_INPUT, `${entity.type} #${expressId} has no property ${field}.`);
      }
      const expected = given ? request.expected : current;
      const preview = previewModelChanges(state, parseOne(tool, asChange(request, target, expected)));
      const row = preview.rows[0];
      const base = { modelId: model.id, expressId, globalId: entity.globalId, entityType: entity.type, field };
      switch (row.status) {
        case 'ready': break;
        case 'unchanged': return { ...base, before: current, after: current, changed: false };
        case 'conflict':
          return refuse(ToolErrorCode.STATE_CHANGED,
            `${field} is ${formatEditValue(row.current ?? null)} now, not the expected ${formatEditValue(row.change.expected)}; nothing was changed.`,
            { current: row.current ?? null, expected: row.change.expected });
        case 'denied':
          return refuse(ToolErrorCode.PERMISSION_DENIED, `The viewer does not allow editing this model now: ${row.denial ?? 'edits are off'}.`);
        case 'missing-target': case 'ambiguous-target':
          return refuse(ToolErrorCode.ENTITY_NOT_FOUND, `GlobalId ${entity.globalId} does not name one entity in model '${model.name}'.`);
        case 'unsupported':
          return refuse(ToolErrorCode.UNSUPPORTED_OPERATION, `${field} cannot be edited by an agent.`);
      }
      const outcome = commitModelChanges(store, preview, new Set([row.index]), AGENT_EDIT_ORIGIN);
      if (!outcome.ok) {
        return refuse(outcome.reason === 'stale' ? ToolErrorCode.STATE_CHANGED : ToolErrorCode.PERMISSION_DENIED,
          `The viewer refused the edit${outcome.detail ? `: ${outcome.detail}` : ''}; nothing was changed.`);
      }
      const [batch] = outcome.receipt.batches;
      const [applied] = outcome.receipt.applied;
      labelAgentChange(batch.batchId, field);
      return { ...base, before: applied.before, after: applied.after, changed: true };
    },
  };
}
