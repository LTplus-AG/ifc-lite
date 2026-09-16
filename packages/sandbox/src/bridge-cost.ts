/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CostEvaluationOptions, EntityRef } from '@ifc-lite/sdk';
import type { NamespaceSchema } from './bridge-schema.js';

function optionalModelId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error('modelId must be a non-empty string when provided');
}

function entityRef(value: unknown): EntityRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('cost evaluation requires a model-qualified EntityRef');
  }
  const candidate = value as Partial<EntityRef>;
  if (typeof candidate.modelId !== 'string' || candidate.modelId.length === 0
    || !Number.isSafeInteger(candidate.expressId) || (candidate.expressId ?? -1) < 0) {
    throw new Error('cost evaluation requires a model-qualified EntityRef with a non-negative safe integer expressId');
  }
  return { modelId: candidate.modelId, expressId: candidate.expressId as number };
}

function evaluationOptions(value: unknown): CostEvaluationOptions | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('cost evaluation options must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const unexpected = Object.keys(candidate).filter(key => key !== 'Precision');
  if (unexpected.length > 0) {
    throw new Error("cost evaluation options only accept the exact 'Precision' field");
  }
  if (candidate.Precision === undefined) return {};
  if (!Number.isInteger(candidate.Precision) || (candidate.Precision as number) < 1 ||
      (candidate.Precision as number) > 10_000) {
    throw new Error('cost evaluation Precision must be an integer from 1 through 10000');
  }
  return { Precision: candidate.Precision as number };
}

export function buildCostNamespace(): NamespaceSchema {
  return {
    name: 'cost',
    doc: 'IFC 5D cost graph and decimal evaluation from the loaded source snapshot',
    permission: 'query',
    methods: [
      { name: 'data', doc: 'Read the complete canonical cost graph.', args: ['dump'], paramNames: ['modelId'], tsParamTypes: ['string | undefined'], tsReturn: 'BimCost.CostGraphData', call: (sdk, args) => sdk.cost.data(optionalModelId(args[0])), returns: 'value' },
      { name: 'schedules', doc: 'List IfcCostSchedule records.', args: ['dump'], paramNames: ['modelId'], tsParamTypes: ['string | undefined'], tsReturn: 'BimCost.CostScheduleData[]', call: (sdk, args) => sdk.cost.schedules(optionalModelId(args[0])), returns: 'value' },
      { name: 'items', doc: 'List IfcCostItem records.', args: ['dump'], paramNames: ['modelId'], tsParamTypes: ['string | undefined'], tsReturn: 'BimCost.CostItemData[]', call: (sdk, args) => sdk.cost.items(optionalModelId(args[0])), returns: 'value' },
      { name: 'values', doc: 'List IfcCostValue and IfcAppliedValue records.', args: ['dump'], paramNames: ['modelId'], tsParamTypes: ['string | undefined'], tsReturn: 'BimCost.CostValueData[]', call: (sdk, args) => sdk.cost.values(optionalModelId(args[0])), returns: 'value' },
      { name: 'evaluateItem', doc: 'Evaluate an IfcCostItem using decimal arithmetic.', args: ['dump', 'dump'], paramNames: ['ref', 'options'], tsParamTypes: ['BimCost.EntityRef', 'BimCost.CostEvaluationOptions | undefined'], tsReturn: 'BimCost.CostEvaluationData', call: (sdk, args) => sdk.cost.evaluateItem(entityRef(args[0]), evaluationOptions(args[1])), returns: 'value' },
      { name: 'evaluateValue', doc: 'Evaluate an IfcCostValue using decimal arithmetic.', args: ['dump', 'dump'], paramNames: ['ref', 'options'], tsParamTypes: ['BimCost.EntityRef', 'BimCost.CostEvaluationOptions | undefined'], tsReturn: 'BimCost.CostEvaluationData', call: (sdk, args) => sdk.cost.evaluateValue(entityRef(args[0]), evaluationOptions(args[1])), returns: 'value' },
    ],
  };
}
