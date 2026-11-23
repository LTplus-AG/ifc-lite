/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Component APIs of the IFC catalog (name + zod schema, no implementation).
 * The viewer pairs each with a React implementation; the agent turns them into
 * the prompt's component signatures. Property order is the Express positional
 * order, so put the most-used property first.
 */

import { VIEWER_ACTIONS } from '../policy.js';
import { C, ColumnSchema, IfcQuerySchema, RefsSchema, ToneSchema, WeightSchema, z } from './schemas.js';

export const EntityTableApi = {
  name: 'EntityTable',
  schema: z
    .object({
      columns: z.array(ColumnSchema).describe('Columns to show, in order'),
      query: IfcQuerySchema.optional(),
      rows: C.DynamicValue.optional().describe('Data binding to a list of row objects with a "ref" key, when a script computed the rows'),
      title: C.DynamicString.optional(),
      groupBy: z.string().optional().describe('Field path to group rows by, e.g. storey or type'),
      sort: z
        .object({ path: z.string(), dir: z.enum(['asc', 'desc']).optional() })
        .optional()
        .describe('Initial sort, e.g. {path: "Qto_SpaceBaseQuantities.NetFloorArea", dir: "desc"}. Users can re-sort by clicking headers'),
      maxRows: z.number().optional().describe('Rows per page, default 50'),
      weight: WeightSchema.optional(),
    })
    .describe('Table of IFC entities from a query or script rows. Clicking a row selects and frames the entity in 3D. Give query or rows, never literal facts.'),
};

export const EntityListApi = {
  name: 'EntityList',
  schema: z
    .object({
      query: IfcQuerySchema.optional(),
      refs: RefsSchema.optional(),
      title: C.DynamicString.optional(),
      label: z.string().optional().describe('Field path used as the item label, default name'),
      weight: WeightSchema.optional(),
    })
    .describe('Compact clickable list of entities. Clicking an item selects it in 3D.'),
};

export const EntityCardApi = {
  name: 'EntityCard',
  schema: z
    .object({
      entity: C.DynamicString.describe('One entity reference "modelId:expressId", or a binding to it. Use "selection" for the current 3D selection'),
      sections: z
        .array(z.enum(['attributes', 'properties', 'quantities', 'materials', 'classifications', 'spatial']))
        .optional()
        .describe('Sections to show, default attributes and properties'),
      weight: WeightSchema.optional(),
    })
    .describe('Inspector card for one entity, read live from the model.'),
};

export const StatItemSchema = z
  .object({
    label: C.DynamicString,
    query: IfcQuerySchema.optional(),
    aggregate: z.enum(['count', 'sum', 'avg', 'min', 'max']).optional().describe('Default count'),
    path: z.string().optional().describe('Numeric property or quantity path for sum / avg / min / max'),
    value: C.DynamicNumber.optional().describe('Data binding to a number a script computed'),
    unit: z.string().optional(),
    tone: ToneSchema.optional(),
  })
  .describe('One KPI tile. Give query (with aggregate) or value');

export const StatGroupApi = {
  name: 'StatGroup',
  schema: z
    .object({
      items: z.array(StatItemSchema),
      weight: WeightSchema.optional(),
    })
    .describe('Row of KPI tiles whose numbers come from queries or script data.'),
};

export const GroupChartApi = {
  name: 'GroupChart',
  schema: z
    .object({
      groupBy: z.string().describe('Field path to group by: type, storey, material or a property path'),
      query: IfcQuerySchema.optional(),
      kind: z.enum(['bar', 'pie']).optional().describe('Default bar'),
      aggregate: z.enum(['count', 'sum']).optional().describe('Default count'),
      path: z.string().optional().describe('Numeric property or quantity path when aggregate is sum'),
      data: C.DynamicValue.optional().describe('Data binding to [{label, value, refs?}] a script computed, instead of a query'),
      title: C.DynamicString.optional(),
      maxGroups: z.number().optional().describe('Largest groups to show, rest folded into Other. Default 12'),
      weight: WeightSchema.optional(),
    })
    .describe('Chart of entity groups. Clicking a bar or slice selects that group in 3D.'),
};

export const ColorLegendApi = {
  name: 'ColorLegend',
  schema: z
    .object({
      by: z.string().describe('Field path to colour by: type, storey, material or a property path'),
      query: IfcQuerySchema.optional(),
      title: C.DynamicString.optional(),
      apply: z.enum(['manual', 'onShow']).optional().describe('manual (default) shows an Apply button; onShow colours the model when rendered'),
      data: C.DynamicValue.optional().describe('Data binding to computed [{label, color, refs?}] legend entries'),
      weight: WeightSchema.optional(),
    })
    .describe('Colour-by legend. Applies one colour per value to the 3D model; each entry toggles visibility.'),
};

export const FollowUpSchema = z
  .object({
    label: z.string(),
    prompt: z.string().describe('Message sent to the assistant when clicked'),
  })
  .describe('Suggested next question');

export const ActionBarApi = {
  name: 'ActionBar',
  schema: z
    .object({
      actions: z.array(z.enum(VIEWER_ACTIONS)).describe('Viewer actions over the target set'),
      query: IfcQuerySchema.optional(),
      refs: RefsSchema.optional(),
      color: z.string().optional().describe('Hex colour for colorize, e.g. #e5484d'),
      followUps: z.array(FollowUpSchema).optional(),
      weight: WeightSchema.optional(),
    })
    .describe('Buttons that act on a set of entities in 3D (select, isolate, colour, fly to, export) plus suggested follow-up questions.'),
};

export const CalloutApi = {
  name: 'Callout',
  schema: z
    .object({
      text: C.DynamicString,
      tone: ToneSchema.optional(),
      title: C.DynamicString.optional(),
      weight: WeightSchema.optional(),
    })
    .describe('Highlighted note, warning or finding.'),
};

export const IFC_COMPONENT_APIS = [
  EntityTableApi,
  EntityListApi,
  EntityCardApi,
  StatGroupApi,
  GroupChartApi,
  ColorLegendApi,
  ActionBarApi,
  CalloutApi,
];

/** Basic-catalog components the IFC catalog keeps (the rest are media or modal). */
export const BASIC_COMPONENT_NAMES = ['Text', 'Row', 'Column', 'Card', 'Tabs', 'Divider', 'Button', 'TextField', 'CheckBox', 'ChoicePicker', 'Slider', 'List'] as const;

export const IFC_COMPONENT_NAMES = IFC_COMPONENT_APIS.map((api) => api.name);
