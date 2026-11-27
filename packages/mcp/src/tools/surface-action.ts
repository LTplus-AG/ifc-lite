/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseRefs, parseRef, MAX_QUERY_LIMIT, safeHexColor } from '@ifc-lite/a2ui';
import { A2UI_APP_URI, DEFAULT_HIGHLIGHT_COLOR, SURFACE_ACTIONS, SURFACE_ACTION_TOOL } from '../apps/a2ui/constants.js';
import { toolError, ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { viewerTools } from './viewer.js';

const ACTION_TO_TOOL = {
  select: 'viewer_select', isolate: 'viewer_isolate', colorize: 'viewer_colorize',
  flyTo: 'viewer_fly_to', resetView: 'viewer_reset',
} as const;

function invalid(message: string): never {
  throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message });
}

/** The lightweight MCP viewer uses its native pick inspector for selection. */
export const viewerSelect: Tool = {
  name: 'viewer_select',
  description: 'Select IFC entities from the model open in the MCP viewer.',
  scope: 'read',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['express_ids'],
    properties: {
      model_id: { type: 'string' },
      express_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: MAX_QUERY_LIMIT * 2 },
    },
  },
  async handler(input, ctx) {
    const viewer = ctx.viewer;
    const state = viewer?.state();
    if (!viewer || !state?.modelId || !viewer.hasConnectedClient()) {
      return toolError({ code: ToolErrorCode.VIEWER_NOT_CONNECTED, message: 'No viewer connected. Open the viewer for this model first.' });
    }
    const model = resolveModel(ctx, input.model_id as string | undefined ?? state.modelId);
    if (model.id !== state.modelId) invalid('The connected viewer has a different model open.');
    const ids = [...new Set(input.express_ids as number[])];
    const selection = ids.map((expressId) => {
      const entity = model.bim.entity({ modelId: model.id, expressId });
      if (!entity) invalid('One or more entities are unavailable.');
      return { expressId, globalId: entity.globalId, ifcType: entity.type };
    });
    await viewer.selectEntities(model, selection);
    return okResult(`Selected ${ids.length} entities.`, { count: ids.length });
  },
};

const tools = new Map([...viewerTools, viewerSelect].map((tool) => [tool.name, tool]));

export const surfaceAction: Tool = {
  name: SURFACE_ACTION_TOOL,
  description: 'Run a visual action from an IFC result surface on its model-qualified entities.',
  scope: 'read', _meta: { ui: { resourceUri: A2UI_APP_URI, visibility: ['app'] } },
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: SURFACE_ACTIONS },
      refs: { type: 'array', items: { type: 'string', maxLength: 512 }, maxItems: MAX_QUERY_LIMIT * 2 },
      color: { type: 'string', maxLength: 32 },
    },
  },
  handler({ action, refs, color }, ctx) {
    const state = ctx.viewer?.state();
    if (!state?.modelId || !ctx.viewer?.hasConnectedClient()) {
      return toolError({ code: ToolErrorCode.VIEWER_NOT_CONNECTED, message: 'No viewer connected. Open the viewer for this model first.' });
    }
    if (Array.isArray(refs) && refs.some((ref) => !parseRef(ref))) invalid('Every ref must be modelId:expressId.');
    const targets = parseRefs(refs);
    if (targets.some((ref) => ref.modelId !== state.modelId)) invalid('The connected viewer has a different model open.');
    if (action !== 'resetView' && targets.length === 0) invalid('Choose at least one entity.');
    const model = resolveModel(ctx, state.modelId);
    if (action !== 'select' && targets.some((ref) => !model.bim.entity(ref))) invalid('One or more entities are unavailable.');
    const args: Record<string, unknown> = { model_id: model.id };
    if (action !== 'resetView') args.express_ids = targets.map((ref) => ref.expressId);
    // The shared hex rule: anything else (an empty legend colour too) gets this host's default.
    if (action === 'colorize') args.color = safeHexColor(color, DEFAULT_HIGHLIGHT_COLOR);
    return tools.get(ACTION_TO_TOOL[action as keyof typeof ACTION_TO_TOOL])!.handler(args, ctx);
  },
};
