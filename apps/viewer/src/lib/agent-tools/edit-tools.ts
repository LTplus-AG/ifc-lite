/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The edit tools the main viewer serves once the user allows it (#9523):
 * set or delete one property, or set one IfcRoot text attribute, on one
 * entity per call. Same names as the stdio server's tools.
 *
 * A tool here only validates its arguments and describes the change. The
 * host's {@link ModelEditor} writes it (in the main viewer, through the
 * reviewed-change commit: one undo step per call). Every tool first asks
 * `ctx.canEdit`, so a call the user has not allowed never reaches the editor,
 * whatever the bridge forwarded.
 */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { EDITABLE_ATTRIBUTES } from '@ifc-lite/ai/artifacts';
import { assertDispatchActive } from './cancellation.js';
import { resolveRef } from './refs.js';
import type { AgentEdit, AgentEditRequest, AgentInputSchema, EditScalar, ModelTool, ReadyModel, ToolCallContext, ToolHost, ToolOutput } from './types.js';

/** Every edit tool, in the order they are listed. */
export const EDIT_TOOL_NAMES = ['entity_set_property', 'entity_delete_property', 'entity_set_attribute'] as const;
export type EditToolName = (typeof EDIT_TOOL_NAMES)[number];

export function isEditTool(name: string): name is EditToolName {
  return (EDIT_TOOL_NAMES as readonly string[]).includes(name);
}

export const editNotAllowed = () => new ToolExecutionError({
  code: ToolErrorCode.READ_ONLY,
  message: 'The user has not allowed the agent to edit this model; the viewer serves it read-only.',
  hint: 'Ask the user to turn on "Allow the agent to edit this model" in the viewer tab, then retry.',
});

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `${key} must be a non-empty string.` });
  }
  return value;
}

/**
 * The request as the agent gave it. Only the names the current value is read
 * by are checked here; values, bounds, data types and the attribute name are
 * checked once, by the reviewed-change parser the editor runs.
 */
function requestFor(name: EditToolName, args: Record<string, unknown>): AgentEditRequest {
  const expected = Object.hasOwn(args, 'expected') ? { expected: args.expected } : {};
  switch (name) {
    case 'entity_set_property':
      return { op: 'property.set', pset: text(args, 'pset'), name: text(args, 'name'), value: args.value,
        ...(args.data_type !== undefined ? { dataType: args.data_type } : {}), ...expected };
    case 'entity_delete_property':
      return { op: 'property.delete', pset: text(args, 'pset'), name: text(args, 'name'), ...expected };
    case 'entity_set_attribute':
      return { op: 'attribute.set', name: text(args, 'attribute'), value: args.value, ...expected };
  }
}

export function formatEditValue(value: EditScalar): string {
  return value === null ? '(none)' : typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function summary(edit: AgentEdit): string {
  const where = `${edit.entityType} #${edit.expressId} (GlobalId ${edit.globalId}, model=${edit.modelId})`;
  if (!edit.changed) return `${edit.field} on ${where} is already ${formatEditValue(edit.after)}; nothing was changed.`;
  const change = edit.after === null
    ? `Deleted ${edit.field} (was ${formatEditValue(edit.before)})`
    : `Set ${edit.field} from ${formatEditValue(edit.before)} to ${formatEditValue(edit.after)}`;
  return `${change} on ${where}. The change is unsaved in the viewer and is one step in its undo history.`;
}

function editTool(name: EditToolName): ModelTool {
  return {
    needs: 'store',
    async run(host: ToolHost, model: ReadyModel, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutput> {
      if (!ctx.canEdit?.()) throw editNotAllowed();
      if (!host.editor) {
        throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: `${name} is not available on this host.` });
      }
      const request = requestFor(name, args);
      const ref = resolveRef(model, args);
      assertDispatchActive(ctx.signal);
      // No await between the grant check above and the write: a revoke cannot land in between.
      const edit = host.editor.apply(model, ref.expressId, request, name);
      return { text: summary(edit), structured: { edit }, edit };
    },
  };
}

export const editTools = Object.fromEntries(EDIT_TOOL_NAMES.map((name) => [name, editTool(name)])) as Record<EditToolName, ModelTool>;

const TARGET_PROPERTIES = {
  global_id: { type: 'string', description: 'GlobalId of the entity to change. Give this or express_id.' },
  express_id: { type: 'integer', minimum: 1, description: 'Express id of the entity to change. Give this or global_id.' },
};

const EXPECTED_NOTE = 'Optional: the value you read before deciding on this edit (null when absent). The edit is refused with STATE_CHANGED if the model holds anything else now, e.g. because the user changed it meanwhile.';

/** Argument schemas and descriptions of the edit tools, as the viewer lists them. */
export const EDIT_TOOL_SPECS: Record<EditToolName, { description: string; inputSchema: AgentInputSchema }> = {
  entity_set_property: {
    description: 'Set one property value in a property set on one entity of the model open in the viewer, creating the property (and set) when absent. Requires the user to have allowed edits in the tab. The change is unsaved, appears in the viewer\'s undo history as one step labelled as the agent\'s, and the user decides whether to export or save it. A property that already holds the same value is left alone (changed: false), even when data_type differs: to change only the type, delete the property, then set it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...TARGET_PROPERTIES,
        pset: { type: 'string', description: 'Property set name, e.g. Pset_WallCommon.' },
        name: { type: 'string', description: 'Property name, e.g. FireRating.' },
        value: { type: ['string', 'number', 'boolean'], description: 'The new value. Numbers are written as integers or reals, text as IfcLabel, unless data_type says otherwise.' },
        data_type: { type: 'string', description: 'Optional IFC value type, e.g. IfcLengthMeasure or IfcText.' },
        expected: { type: ['string', 'number', 'boolean', 'null'], description: EXPECTED_NOTE },
      },
      required: ['pset', 'name', 'value'],
    },
  },
  entity_delete_property: {
    description: 'Delete one property from a property set on one entity of the model open in the viewer. Requires the user to have allowed edits in the tab. One undo step in the viewer, labelled as the agent\'s.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...TARGET_PROPERTIES,
        pset: { type: 'string', description: 'Property set name.' },
        name: { type: 'string', description: 'Property name.' },
        expected: { type: ['string', 'number', 'boolean'], description: 'Optional: the value you read before deciding to delete it. The delete is refused with STATE_CHANGED if the model holds anything else now (including no value), e.g. because the user changed it meanwhile.' },
      },
      required: ['pset', 'name'],
    },
  },
  entity_set_attribute: {
    description: 'Set Name, Description, ObjectType or Tag on one entity of the model open in the viewer. Requires the user to have allowed edits in the tab. One undo step in the viewer, labelled as the agent\'s. GlobalId cannot be changed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...TARGET_PROPERTIES,
        attribute: { type: 'string', enum: [...EDITABLE_ATTRIBUTES], description: 'The attribute to set.' },
        value: { type: 'string', description: 'The new text. An empty string clears the attribute.' },
        expected: { type: ['string', 'null'], description: EXPECTED_NOTE },
      },
      required: ['attribute', 'value'],
    },
  },
};
