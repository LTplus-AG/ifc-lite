/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TopConstraint } from '@ifc-lite/create';
import type { JsonSchema } from '../protocol/index.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { storeyAddInput } from './storey-add-input.js';

const id: JsonSchema = { type: 'integer', minimum: 1 };
const modelId: JsonSchema = { type: 'string', description: 'Required when multiple models are loaded.' };
const ids: JsonSchema = { type: 'array', items: id, minItems: 1, maxItems: 10000 };
const constraint = (kind: TopConstraint['kind'], target?: string): JsonSchema => ({
  type: 'object', properties: { kind: { type: 'string', enum: [kind] }, ...(target ? { [target]: id } : {}) },
  required: ['kind', ...(target ? [target] : [])], additionalProperties: false,
});
const invalid = (error: unknown): never => {
  throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error instanceof Error ? error.message : String(error) });
};

/** The same SDK plans and writes as storey authoring, exposed without raw STEP edits (#9352). */
export const storeyFollowUpTools: Tool[] = [
  {
    name: 'storey_plan_add', scope: 'read',
    description: 'Dry run of adding a storey: refusal, relative top bindings and elements that cannot resize. Writes nothing. Accepts Name and Elevation, or a reference storey and side as storey_add does. Elevation is metres.',
    inputSchema: { type: 'object', properties: {
      model_id: modelId, Name: { type: 'string', minLength: 1 }, Elevation: { type: 'number' },
      Description: { type: 'string' }, LongName: { type: 'string' }, GlobalId: { type: 'string' },
      reference_storey_express_id: id, side: { type: 'string', enum: ['above', 'below'] }, building_express_id: id,
    }, anyOf: [{ required: ['Name', 'Elevation'] }, { required: ['reference_storey_express_id'] }], additionalProperties: false },
    handler(input, ctx) {
      const model = resolveModel(ctx, input.model_id as string | undefined);
      try {
        const params = storeyAddInput(input, (reference, side) => model.bim.store.suggestStorey(model.id, reference, side));
        const plan = model.bim.store.planAddStorey(model.id, params);
        return okResult(plan.refusal ? `Refused: ${plan.refusal}` : `Binds ${plan.bindings.length} element(s); ${plan.unresized.length} cannot resize.`, { ...plan });
      } catch (error) { return invalid(error); }
    },
  },
  {
    name: 'set_top_constraint', scope: 'mutate',
    description: 'Fit an element top to the next storey, an explicit storey, a slab underside, a roof underside (walls), or make it fixed. The constraint has the SDK shape. One mutation_undo reverts placement, geometry and attachment together.',
    inputSchema: { type: 'object', properties: {
      model_id: modelId, express_id: id, constraint: { anyOf: [constraint('fixed'), constraint('storeyAbove'),
        constraint('storey', 'storeyId'), constraint('slab', 'slabId'), constraint('roof', 'roofId')] },
    }, required: ['express_id', 'constraint'], additionalProperties: false },
    handler(input, ctx) {
      const model = resolveModel(ctx, input.model_id as string | undefined);
      try {
        const changed = model.bim.store.setTopConstraint({ modelId: model.id, expressId: input.express_id as number }, input.constraint as TopConstraint);
        return okResult(`Updated the top constraint; ${changed.length} element(s) changed.`, { changed });
      } catch (error) { return invalid(error); }
    },
  },
  {
    name: 'copy_to_storeys', scope: 'mutate',
    description: 'Copy selected products to each target storey, carrying their hosted children and rebinding relative tops. Returns selected copies and unattached-top notices per storey. One mutation_undo removes the whole operation.',
    inputSchema: { type: 'object', properties: { model_id: modelId, express_ids: ids, storey_express_ids: ids },
      required: ['express_ids', 'storey_express_ids'], additionalProperties: false },
    handler(input, ctx) {
      const model = resolveModel(ctx, input.model_id as string | undefined);
      try {
        const copies = model.bim.store.copyToStoreys(model.id, input.express_ids as number[], input.storey_express_ids as number[]);
        const storeys = copies.map(group => ({ storeyId: group.storeyId, entities: group.refs,
          unattachedTops: group.refs.flatMap(ref => ref.unattachedTops ?? []) }));
        const count = storeys.reduce((n, group) => n + group.entities.length, 0);
        const unattached = storeys.flatMap(group => group.unattachedTops);
        const notice = unattached.length ? ` ${unattached.length} copied top(s) remain unattached: ${unattached.map(top => `#${top.expressId} ${top.reason}`).join('; ')}.` : '';
        return okResult(`Copied ${count} selected product(s) to ${storeys.length} storey(s).${notice}`, { modelId: model.id, storeys });
      } catch (error) { return invalid(error); }
    },
  },
];
