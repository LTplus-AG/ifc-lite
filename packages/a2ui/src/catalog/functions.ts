/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renderer-side functions of the IFC catalog. `allowedCallers` and
 * `requiresUserActivation` are derived from `IFC_FUNCTION_POLICY`, so the trust
 * table in `policy.ts` is the only place they are decided.
 */

import type { FunctionApi } from '@a2ui/web_core/v1_0';
import { IFC_FUNCTION_POLICY, type IfcFunctionName } from '../policy.js';
import { C, ColumnSchema, IfcQuerySchema, RefsSchema, z } from './schemas.js';

const targetShape = {
  refs: RefsSchema.optional(),
  query: IfcQuerySchema.optional(),
};

function api(
  name: IfcFunctionName,
  returnType: FunctionApi['returnType'],
  description: string,
  schema: z.ZodTypeAny,
): FunctionApi {
  const policy = IFC_FUNCTION_POLICY[name];
  return {
    name,
    returnType,
    description,
    schema,
    allowedCallers: policy.agentCallable ? 'rendererOrAgent' : 'rendererOnly',
    ...(policy.userActivation ? { requiresUserActivation: true } : {}),
  };
}

export const IFC_FUNCTION_APIS: FunctionApi[] = [
  api('select', 'void', 'Select entities in the 3D view (give refs or query).', z.object(targetShape)),
  api('isolate', 'void', 'Show only these entities in the 3D view.', z.object(targetShape)),
  api('hide', 'void', 'Hide these entities in the 3D view.', z.object(targetShape)),
  api('show', 'void', 'Unhide these entities in the 3D view.', z.object(targetShape)),
  api(
    'colorize',
    'void',
    'Colour these entities in the 3D view.',
    z.object({ ...targetShape, color: C.DynamicString.describe('Hex colour such as #e5484d') }),
  ),
  api('flyTo', 'void', 'Frame these entities in the 3D view.', z.object(targetShape)),
  api('resetView', 'void', 'Show everything again and clear colours.', z.object({})),
  api('getSelection', 'array', 'The current 3D selection as "modelId:expressId" refs.', z.object({})),
  api('countEntities', 'number', 'Number of entities matching a query.', z.object({ query: IfcQuerySchema })),
  api(
    'sumQuantity',
    'number',
    'Sum of a numeric property or quantity over a query.',
    z.object({ query: IfcQuerySchema, path: z.string().describe('Property or quantity path, e.g. Qto_WallBaseQuantities.NetVolume') }),
  ),
  api(
    'exportCsv',
    'void',
    'Download the entities as CSV. Runs only from a user click.',
    z.object({ ...targetShape, columns: z.array(ColumnSchema).optional() }),
  ),
];

/** Basic-catalog functions the IFC catalog keeps. */
export const BASIC_FUNCTION_NAMES = ['formatString', 'formatNumber', 'pluralize', 'required', 'and', 'or', 'not'] as const;
