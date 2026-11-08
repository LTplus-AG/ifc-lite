/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Storey authoring over `bim.store` (#9013): the same plan/apply path as the
 * viewer's storey manager. Lengths are metres. Re-levelling moves real
 * placements (geometry follows storeys), drives walls attached to the storey
 * above and refits stairs; every refusal is reported before anything is
 * written, and each write is one mutation_undo step.
 */

import { readStoreyInventory, suggestStorey, type StoreyDeleteMode, type StoreyLevelEdit } from '@ifc-lite/create';
import type { JsonSchema } from '../protocol/index.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { ToolContext } from '../context.js';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';

const modelId: JsonSchema = { type: 'string', description: 'Required when multiple models are loaded.' };
const storeyId: JsonSchema = { type: 'integer', minimum: 1, description: 'IfcBuildingStorey express id.' };
const level: Record<string, JsonSchema> = {
  model_id: modelId,
  storey_express_id: storeyId,
  kind: { type: 'string', enum: ['elevation', 'floor_height'], description: '`elevation` moves this storey only; `floor_height` sets its floor-to-floor height and shifts every storey above.' },
  value: { type: 'number', description: 'Metres: the new elevation, or the new floor-to-floor height.' },
};

function fail(error: unknown): never {
  throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error instanceof Error ? error.message : String(error) });
}

function levelEdit(input: Record<string, unknown>): StoreyLevelEdit {
  const storey = input.storey_express_id as number;
  const value = input.value as number;
  return input.kind === 'floor_height'
    ? { kind: 'floorHeight', storeyId: storey, Height: value }
    : { kind: 'elevation', storeyId: storey, Elevation: value };
}

function store(ctx: ToolContext, input: Record<string, unknown>) {
  const model = resolveModel(ctx, input.model_id as string | undefined);
  return { model, store: model.bim.store };
}

const storeyList: Tool = {
  name: 'storey_list',
  description: 'List the live storeys of a model, highest first: express id, GlobalId, Name, elevation (m), floor-to-floor height to the storey above (m, null for the top storey) and element count.',
  scope: 'read',
  inputSchema: { type: 'object', properties: { model_id: modelId }, additionalProperties: false },
  handler(input, ctx) {
    const { model, store: s } = store(ctx, input);
    const rows = s.listStoreyLevels(model.id);
    return okResult(rows.map((row) => `#${row.expressId} ${row.Name} ${row.elevation.toFixed(3)} m`).join('\n') || 'No storeys.', { storeys: rows });
  },
};

const storeyAdd: Tool = {
  name: 'storey_add',
  description: 'Add an IfcBuildingStorey, aggregated under the building and placed like its neighbours. '
    + 'Give Name and Elevation, or a reference storey and side to take the neighbours\' naming and spacing. One mutation_undo removes it.',
  scope: 'mutate',
  inputSchema: {
    type: 'object', properties: {
      model_id: modelId, Name: { type: 'string', minLength: 1 }, Elevation: { type: 'number', description: 'Metres.' },
      reference_storey_express_id: storeyId, side: { type: 'string', enum: ['above', 'below'] },
    }, additionalProperties: false,
  },
  handler(input, ctx) {
    const { model, store: s } = store(ctx, input);
    try {
      const reference = input.reference_storey_express_id as number | undefined;
      let Name = input.Name as string | undefined;
      let Elevation = input.Elevation as number | undefined;
      if (Name === undefined || Elevation === undefined) {
        if (reference === undefined) throw new Error('Give Name and Elevation, or reference_storey_express_id and side');
        const view = model.backend.getOrCreateMutationView();
        const inventory = readStoreyInventory(model.store, view);
        const suggestion = suggestStorey(inventory, reference, (input.side as 'above' | 'below' | undefined) ?? 'above', (n) => `Level ${n}`);
        Name ??= suggestion.Name;
        Elevation ??= suggestion.Elevation;
      }
      const ref = s.addStorey(model.id, { Name, Elevation, ...(reference === undefined ? {} : { referenceStoreyId: reference }) });
      return okResult(`Added ${Name} at ${Elevation.toFixed(3)} m as #${ref.expressId}.`, { ...ref, Name, Elevation });
    } catch (error) { return fail(error); }
  },
};

const storeyRename: Tool = {
  name: 'storey_rename',
  description: 'Rename a storey (IfcRoot.Name). One mutation_undo reverts it.',
  scope: 'mutate',
  inputSchema: { type: 'object', properties: { model_id: modelId, storey_express_id: storeyId, Name: { type: 'string', minLength: 1 } }, required: ['storey_express_id', 'Name'], additionalProperties: false },
  handler(input, ctx) {
    const { model, store: s } = store(ctx, input);
    try {
      const ref = s.renameStorey({ modelId: model.id, expressId: input.storey_express_id as number }, input.Name as string);
      return okResult(`Renamed #${ref.expressId} to ${String(input.Name)}.`, { ...ref });
    } catch (error) { return fail(error); }
  },
};

const storeyPlanEdit: Tool = {
  name: 'storey_plan_edit',
  description: 'Dry run of storey_edit: which storeys and elements would move, which attached walls resize and which stairs refit, '
    + 'plus every refusal (zero spacing, crossing a neighbour, no valid stair flight, shared placements) and notices for elements left as they are. Writes nothing.',
  scope: 'read',
  inputSchema: { type: 'object', properties: level, required: ['storey_express_id', 'kind', 'value'], additionalProperties: false },
  handler(input, ctx) {
    const { model, store: s } = store(ctx, input);
    const plan = s.planStoreyEdit(model.id, levelEdit(input));
    const text = plan.refusals.length
      ? `Refused: ${plan.refusals.map((r) => r.message).join('; ')}`
      : `Moves ${plan.storeys.length} storey(s) and ${plan.movedElementCount} element(s); resizes ${plan.walls.length} wall(s); refits ${plan.stairs.length} stair(s).`;
    return okResult(text, {
      refusals: plan.refusals, notices: plan.notices, storeys: plan.storeys, walls: plan.walls, stairs: plan.stairs,
      movedElementCount: plan.movedElementCount, moved: plan.moved, held: plan.held,
    });
  },
};

const storeyEdit: Tool = {
  name: 'storey_edit',
  description: 'Re-level a storey: `elevation` moves that storey only, `floor_height` shifts every storey above by the same amount. '
    + 'Contents move with their storey through real placement writes; walls attached to the storey above resize and stairs refit. '
    + 'Refused (nothing written) when storey_plan_edit reports a refusal. One mutation_undo reverts the whole edit.',
  scope: 'mutate',
  inputSchema: { type: 'object', properties: level, required: ['storey_express_id', 'kind', 'value'], additionalProperties: false },
  handler(input, ctx) {
    const { model, store: s } = store(ctx, input);
    try {
      const changed = s.editStorey(model.id, levelEdit(input));
      return okResult(`Edited storey #${String(input.storey_express_id)}; ${changed.length} entities changed.`, { changed });
    } catch (error) { return fail(error); }
  },
};

const storeyDelete: Tool = {
  name: 'storey_delete',
  description: 'Delete a storey without orphaning elements: `empty` (refused while it holds elements), `move` its contents to target_storey_express_id '
    + '(same identities and world positions), or `delete_contents`. A model keeps at least one storey. One mutation_undo restores it.',
  scope: 'mutate',
  inputSchema: {
    type: 'object', properties: {
      model_id: modelId, storey_express_id: storeyId,
      mode: { type: 'string', enum: ['empty', 'move', 'delete_contents'] }, target_storey_express_id: storeyId,
    }, required: ['storey_express_id', 'mode'], additionalProperties: false,
  },
  handler(input, ctx) {
    const { model, store: s } = store(ctx, input);
    const mode: StoreyDeleteMode = input.mode === 'move'
      ? { kind: 'move', targetStoreyId: input.target_storey_express_id as number }
      : input.mode === 'delete_contents' ? { kind: 'deleteContents' } : { kind: 'empty' };
    try {
      const removed = s.deleteStorey({ modelId: model.id, expressId: input.storey_express_id as number }, mode);
      return okResult(`Deleted storey #${String(input.storey_express_id)}.`, { removed });
    } catch (error) { return fail(error); }
  },
};

export const storeyTools: Tool[] = [storeyList, storeyAdd, storeyRename, storeyPlanEdit, storeyEdit, storeyDelete];
