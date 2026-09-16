/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import type { DispatchContext, LoadedPlaygroundModel } from './playground-dispatcher.js';

type Result = { text: string; structured: unknown };
type Handler = (model: LoadedPlaygroundModel, args: Record<string, unknown>, context: DispatchContext) => Promise<Result>;

function selectedModel(model: LoadedPlaygroundModel, args: Record<string, unknown>, context: DispatchContext) {
  const modelId = String(args.model_id ?? model.id);
  const selected = modelId === model.id ? model : context.registry?.get(modelId);
  if (!selected) throw new ToolExecutionError({ code: ToolErrorCode.MODEL_NOT_FOUND, message: `Model '${modelId}' not loaded.` });
  return selected;
}

export const playgroundCostTools: Record<string, Handler> = {
  async cost_data(model, args, context) {
    const selected = selectedModel(model, args, context);
    const data = selected.bim.cost.data(selected.id);
    return {
      text: `Read ${data.CostItems.length} cost items and ${data.CostValues.length} cost values from '${selected.name}'.`,
      structured: { data },
    };
  },

  async cost_evaluate(model, args, context) {
    const selected = selectedModel(model, args, context);
    const expressId = args.express_id;
    const target = args.target;
    if (typeof expressId !== 'number' || !Number.isSafeInteger(expressId) || expressId < 0) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: 'express_id must be a non-negative safe integer.',
      });
    }
    if (target !== 'item' && target !== 'value') {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: "target must be 'item' or 'value'.",
      });
    }
    const precision = args.precision;
    if (
      precision !== undefined &&
      (typeof precision !== 'number' || !Number.isInteger(precision) || precision < 1 || precision > 10_000)
    ) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: 'precision must be an integer from 1 through 10000.',
      });
    }
    const options = precision === undefined ? undefined : { Precision: precision };
    const entityRef = { modelId: selected.id, expressId };
    const evaluation = target === 'item'
      ? selected.bim.cost.evaluateItem(entityRef, options)
      : selected.bim.cost.evaluateValue(entityRef, options);
    return {
      text: evaluation.Amount === undefined
        ? `Cost ${target} #${expressId} could not be evaluated from the loaded source snapshot; inspect diagnostics.`
        : `Cost ${target} #${expressId} evaluates to ${evaluation.Amount}${evaluation.Currency ? ` ${evaluation.Currency}` : ''} in the loaded source snapshot.`,
      structured: { source: 'loaded-source', evaluation },
    };
  },
};
