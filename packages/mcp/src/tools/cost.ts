/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

const modelProperty = { model_id: { type: 'string', description: 'Loaded model id; required when multiple models are loaded.' } } as const;

const costData: Tool = {
  name: 'cost_data',
  description: 'Read the canonical IFC 5D cost graph from the loaded source snapshot.',
  scope: 'read',
  inputSchema: { type: 'object', properties: modelProperty, additionalProperties: false },
  handler(input, ctx) {
    const model = resolveModel(ctx, input.model_id as string | undefined);
    const data = model.bim.cost.data(model.id);
    return okResult(`Read ${data.CostItems.length} cost items and ${data.CostValues.length} cost values from model '${model.id}'.`, { data });
  },
};

const costEvaluate: Tool = {
  name: 'cost_evaluate',
  description: 'Evaluate one IfcCostItem or IfcCostValue from the loaded source snapshot using decimal arithmetic and return diagnostics.',
  scope: 'read',
  inputSchema: {
    type: 'object', required: ['target', 'express_id'],
    properties: {
      ...modelProperty,
      target: { type: 'string', enum: ['item', 'value'] },
      express_id: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      precision: { type: 'integer', minimum: 1, maximum: 10_000 },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const model = resolveModel(ctx, input.model_id as string | undefined);
    const expressId = input.express_id;
    if (!Number.isSafeInteger(expressId) || (expressId as number) < 0) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'express_id must be a non-negative safe integer.' });
    }
    const target = input.target;
    if (target !== 'item' && target !== 'value') {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: "target must be 'item' or 'value'." });
    }
    const precision = input.precision;
    if (precision !== undefined &&
        (!Number.isInteger(precision) || (precision as number) < 1 || (precision as number) > 10_000)) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT,
        message: 'precision must be an integer from 1 through 10000.' });
    }
    const options = precision === undefined ? undefined : { Precision: precision as number };
    const entityRef = { modelId: model.id, expressId: expressId as number };
    const evaluation = target === 'item'
      ? model.bim.cost.evaluateItem(entityRef, options)
      : model.bim.cost.evaluateValue(entityRef, options);
    return okResult(
      evaluation.Amount === undefined
        ? `Cost ${target} #${String(expressId)} could not be evaluated from the loaded source snapshot; inspect diagnostics.`
        : `Cost ${target} #${String(expressId)} evaluates to ${evaluation.Amount}${evaluation.Currency ? ` ${evaluation.Currency}` : ''} in the loaded source snapshot.`,
      { source: 'loaded-source', evaluation },
    );
  },
};

export const costTools: Tool[] = [costData, costEvaluate];
