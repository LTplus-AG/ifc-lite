/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SectionSpec, SurfaceSpec } from '@ifc-lite/a2ui';
import type { EntityRef } from '@ifc-lite/sdk';
import type { MethodSchema, NamespaceSchema } from './bridge-schema.js';

export type ScriptUiRef = string | EntityRef;
export type ScriptUiRow = (Record<string, unknown> & { ref?: ScriptUiRef }) | { ref: ScriptUiRef };
type SectionOf<Kind extends SectionSpec['kind']> = Extract<SectionSpec, { kind: Kind }>;

export type ScriptUiSection =
  | Exclude<SectionSpec, { kind: 'table' | 'chart' | 'entity' | 'list' | 'actions' }>
  | (Omit<SectionOf<'table'>, 'rows'> & { rows?: ScriptUiRow[] })
  | (Omit<SectionOf<'chart'>, 'data'> & {
      data?: (Omit<NonNullable<SectionOf<'chart'>['data']>[number], 'refs'> & { refs?: ScriptUiRef[] })[];
    })
  | (Omit<SectionOf<'entity'>, 'entity'> & { entity: ScriptUiRef })
  | (Omit<SectionOf<'list'>, 'refs'> & { refs?: ScriptUiRef[] })
  | (Omit<SectionOf<'actions'>, 'refs'> & { refs?: ScriptUiRef[] });

export type ScriptUiSurface = Omit<SurfaceSpec, 'surfaceId' | 'sections'> & { sections: ScriptUiSection[] };

type UiMethod = Exclude<SectionSpec['kind'], 'text'> | 'show';

const methodDocs: Record<UiMethod, string> = {
  table: 'Show a table with columns [{path, label?}] and either computed rows or an IFC query. Pass query results directly as rows, or map them to objects keyed by column path with an optional ref.',
  stats: 'Show KPI tiles from items [{label, value?, query?, aggregate?, path?, unit?, tone?}]. Supply a computed value or a query for each item.',
  chart: 'Show a bar or pie chart grouped by groupBy, with a query or computed data [{label, value, refs?}].',
  legend: 'Show a colour legend grouped by the field path by, with an optional IFC query.',
  actions: 'Show viewer actions for refs or a query. Supply actions such as select, isolate, flyTo or exportCsv, and optional followUps [{label, prompt}].',
  callout: 'Show a highlighted note with text and optional title and tone.',
  entity: 'Show an IFC entity card for an EntityRef object or a "modelId:expressId" string.',
  list: 'Show a compact entity list from refs or an IFC query, with an optional title and label field path.',
  show: 'Show several sections in one surface. Pass { title?, card?, sections: [{ kind, ...fields }] }. Supported kinds are text, table, stats, chart, legend, actions, callout, entity and list.',
};

function uiMethod(name: UiMethod, doc: string): MethodSchema {
  const inputType = name === 'show' ? 'BimUi.ScriptUiSurface'
    : name === 'entity' ? 'BimUi.ScriptUiRef'
    : `Omit<Extract<BimUi.ScriptUiSection, { kind: '${name}' }>, 'kind'>`;
  return {
    name,
    doc,
    args: ['dump'],
    paramNames: [name === 'entity' ? 'ref' : 'spec'],
    tsParamTypes: [inputType],
    returns: 'string',
    call: (_sdk, [input], { appendUiSurface }) => {
      if (!appendUiSurface) throw new Error('No active surface capture');
      return appendUiSurface(name, input);
    },
  };
}

export type AppendUiSurface = (method: UiMethod, input: unknown) => string;

export function buildUiNamespace(): NamespaceSchema {
  return {
    name: 'ui',
    permission: 'ui',
    doc: 'Present computed results as A2UI surfaces and return a host-generated surface ID. Limits per run are 8 surfaces, 2000 rows per table and 256 KiB of serialized surfaces. Example: const walls = bim.query.byType("IfcWall"); bim.ui.table({ columns: [{ path: "Name" }], rows: walls });',
    methods: (Object.entries(methodDocs) as [UiMethod, string][]).map(([name, doc]) => uiMethod(name, doc)),
  };
}
