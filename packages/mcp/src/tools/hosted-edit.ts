/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { HostedElementEdit } from '@ifc-lite/create';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';

/** #6232 D5: hosted.slide and inspector dimensions share their physical edit core. */
export const hostedEditTool: Tool = {
  name: 'edit_hosted_element',
  description: 'Move or resize a live wall-hosted opening, door or window together with its actual cut. '
    + 'Offset and Sill are metres in the host frame; OverallWidth/OverallHeight are metres. '
    + 'Identity and relationships are retained. Overlap, out-of-host and unsupported geometry edits are refused atomically. '
    + 'One mutation_undo restores the preceding graph.',
  scope: 'mutate',
  inputSchema: {
    type: 'object', properties: {
      model_id: { type: 'string', description: 'Required when multiple models are loaded.' },
      express_id: { type: 'integer', minimum: 1 },
      patch: {
        type: 'object', properties: {
          OverallWidth: { type: 'number', minimum: 0 }, OverallHeight: { type: 'number', minimum: 0 },
          Offset: { type: 'number' }, Sill: { type: 'number' },
        }, additionalProperties: false, anyOf: ['OverallWidth', 'OverallHeight', 'Offset', 'Sill'].map(name => ({ required: [name] })),
      },
    }, required: ['express_id', 'patch'], additionalProperties: false,
  },
  handler(input, ctx) {
    const model = resolveModel(ctx, input.model_id as string | undefined);
    try {
      const ref = model.bim.store.editHostedElement({ modelId: model.id, expressId: input.express_id as number }, input.patch as HostedElementEdit);
      return okResult(`Edited hosted element #${ref.expressId}.`, { ...ref });
    } catch (error) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error instanceof Error ? error.message : String(error) });
    }
  },
};
