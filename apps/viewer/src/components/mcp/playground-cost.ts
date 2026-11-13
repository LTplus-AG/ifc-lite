/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { costTools } from '@/lib/agent-tools/cost-tools';
import { playgroundModelHandle, playgroundToolHost } from './playground-tool-host';
import type { DispatchContext, LoadedPlaygroundModel } from './playground-dispatcher.js';

type Result = { text: string; structured: unknown };
type Handler = (model: LoadedPlaygroundModel, args: Record<string, unknown>, context: DispatchContext) => Promise<Result>;

/** The playground reaches a second model through `ctx.registry`, so cost tools resolve `model_id` there. */
function selectedModel(model: LoadedPlaygroundModel, args: Record<string, unknown>, context: DispatchContext) {
  const modelId = String(args.model_id ?? model.id);
  const selected = modelId === model.id ? model : context.registry?.get(modelId);
  if (!selected) throw new ToolExecutionError({ code: ToolErrorCode.MODEL_NOT_FOUND, message: `Model '${modelId}' not loaded.` });
  return selected;
}

function onSelectedModel(name: keyof typeof costTools): Handler {
  return async (model, args, context) => {
    const selected = selectedModel(model, args, context);
    return costTools[name].run(playgroundToolHost(model), playgroundModelHandle(selected), args, context);
  };
}

export const playgroundCostTools: Record<string, Handler> = {
  cost_data: onSelectedModel('cost_data'),
  cost_evaluate: onSelectedModel('cost_evaluate'),
};
