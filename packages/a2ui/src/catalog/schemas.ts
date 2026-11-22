/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared zod schemas for IFC catalog properties.
 *
 * A2UI 0.15 is written against the zod 3 API. The workspace pins zod 4 for a
 * security advisory, and `patches/@a2ui__*.patch` points A2UI at zod 4's
 * bundled `zod/v3` API, so every schema handed to A2UI must come from
 * `zod/v3` too. Mixing in a zod 4 schema silently drops its properties.
 */

import { z } from 'zod/v3';
import { CommonSchemas as C } from '@a2ui/web_core/v1_0';
import { QUERY_OPERATORS } from '../query.js';

export { z, C };

export const QueryConditionSchema = z
  .object({
    path: z.string().describe('Field path: name, type, storey, material, an IFC attribute such as Tag, or Pset.Property such as Pset_DoorCommon.FireRating'),
    op: z.enum(QUERY_OPERATORS).describe('Comparison. exists / missing take no value'),
    value: C.DynamicValue.optional().describe('Literal or data binding to compare with'),
  })
  .describe('One filter condition');

export const IfcQuerySchema = z
  .object({
    types: C.DynamicStringList.optional().describe('IFC class names such as ["IfcDoor"]. Omit for every product'),
    where: z.array(QueryConditionSchema).optional().describe('All conditions must hold'),
    storey: C.DynamicString.optional().describe('Storey name to restrict to'),
    modelId: z.string().optional().describe('Loaded model id to restrict to. Omit to search every loaded model'),
    limit: z.number().optional().describe('Maximum entities, default 500'),
  })
  .describe('Declarative IFC query. The viewer evaluates it against the loaded models, so results are always real');

export const ColumnSchema = z
  .object({
    path: z.string().describe('Field path (see query.where.path) or, for script rows, the row key'),
    label: z.string().optional().describe('Header text. Defaults to the path'),
  })
  .describe('Table column');

export const RefsSchema = C.DynamicStringList.describe(
  'Entity references as "modelId:expressId" strings, usually a data binding to a list a script produced',
);

export const ToneSchema = z.enum(['neutral', 'info', 'success', 'warn', 'error']);

export const WeightSchema = z
  .number()
  .describe('Relative weight inside a Row or Column, like CSS flex-grow. Only on direct children of Row or Column');
