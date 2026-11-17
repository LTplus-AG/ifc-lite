/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { entityExists } from './refs.js';
import type { ModelTool } from './types.js';

/** `bim.cost` reads: the model's cost records through its pending-edit overlay. */
export const costTools: Record<'cost_data' | 'cost_evaluate', ModelTool> = {
  cost_data: {
    needs: 'source',
    async run(_host, model) {
      const data = model.bim.cost.data(model.id);
      return {
        text: `Read ${data.CostItems.length} cost items and ${data.CostValues.length} cost values from '${model.name}'.`,
        structured: { data },
      };
    },
  },

  cost_evaluate: {
    needs: 'source',
    async run(_host, model, args) {
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
      if (!entityExists(model, expressId)) {
        throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `No entity #${expressId} in this model.` });
      }
      const options = precision === undefined ? undefined : { Precision: precision };
      const entityRef = { modelId: model.id, expressId };
      const evaluation = target === 'item'
        ? model.bim.cost.evaluateItem(entityRef, options)
        : model.bim.cost.evaluateValue(entityRef, options);
      return {
        text: evaluation.Amount === undefined
          ? `Cost ${target} #${expressId} could not be evaluated from the loaded source snapshot; inspect diagnostics.`
          : `Cost ${target} #${expressId} evaluates to ${evaluation.Amount}${evaluation.Currency ? ` ${evaluation.Currency}` : ''} in the loaded source snapshot.`,
        structured: { source: 'loaded-source', evaluation },
      };
    },
  },
};
