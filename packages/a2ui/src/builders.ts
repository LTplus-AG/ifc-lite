/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic surface builders: turn data a program computed into A2UI v1.0
 * messages for the IFC catalog. Scripts (`bim.ui.*`) and MCP tools use these,
 * so no model writes the layout and every value sits in the data model, bound
 * by path. Output is plain JSON; validate with `validateIfcMessages` from
 * `@ifc-lite/a2ui/agent` before trusting input that did not come from here.
 */

import type { IfcQuerySpec } from './query.js';
import { A2UI_PROTOCOL_VERSION, IFC_CATALOG_ID, type ViewerAction } from './policy.js';

export type Tone = 'neutral' | 'info' | 'success' | 'warn' | 'error';

export interface ColumnSpec {
  path: string;
  label?: string;
}

/** A script row: `ref` ("modelId:expressId") plus one value per column path. */
export type RowSpec = { ref?: string } & Record<string, unknown>;

export interface StatSpec {
  label: string;
  value?: number;
  query?: IfcQuerySpec;
  aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max';
  path?: string;
  unit?: string;
  tone?: Tone;
}

export interface ChartDatum {
  label: string;
  value: number;
  refs?: string[];
}

/** Every section kind `buildSurface` understands. */
export const SECTION_KINDS = ['text', 'callout', 'stats', 'table', 'list', 'chart', 'legend', 'actions', 'entity'] as const;

export type SectionSpec =
  | { kind: 'text'; text: string; variant?: 'body' | 'caption' }
  | { kind: 'callout'; text: string; tone?: Tone; title?: string }
  | { kind: 'stats'; items: StatSpec[] }
  | { kind: 'table'; columns: ColumnSpec[]; rows?: RowSpec[]; query?: IfcQuerySpec; title?: string; groupBy?: string; sort?: { path: string; dir?: 'asc' | 'desc' }; maxRows?: number }
  | { kind: 'list'; refs?: string[]; query?: IfcQuerySpec; title?: string; label?: string }
  | { kind: 'chart'; groupBy: string; data?: ChartDatum[]; query?: IfcQuerySpec; chart?: 'bar' | 'pie'; aggregate?: 'count' | 'sum'; path?: string; title?: string }
  | { kind: 'legend'; by: string; data?: Array<{ label: string; color: string; refs?: string[] }>; query?: IfcQuerySpec; title?: string; apply?: 'manual' | 'onShow' }
  | { kind: 'actions'; actions: ViewerAction[]; refs?: string[]; query?: IfcQuerySpec; color?: string; followUps?: { label: string; prompt: string }[] }
  | { kind: 'entity'; entity: string; sections?: string[] };

export interface SurfaceSpec {
  surfaceId: string;
  title?: string;
  sections: SectionSpec[];
  /** Wrap in a Card (default true). */
  card?: boolean;
}

type Component = Record<string, unknown> & { id: string; component: string };

/** A2UI v1.0 `createSurface` envelope with components and data inline. */
export interface CreateSurfaceMessage {
  version: typeof A2UI_PROTOCOL_VERSION;
  createSurface: {
    surfaceId: string;
    catalogId: string;
    components: Component[];
    dataModel: Record<string, unknown>;
  };
}

const bind = (path: string) => ({ '@path': path });

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function buildSurface(spec: SurfaceSpec): CreateSurfaceMessage[] {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(spec.surfaceId)) {
    throw new Error(`surfaceId must be 1-128 characters of letters, digits, _ . : -, got "${spec.surfaceId}"`);
  }
  const components: Component[] = [];
  const data: Record<string, unknown> = {};
  const childIds: string[] = [];
  if (spec.title) {
    components.push({ id: 'title', component: 'Text', text: `**${spec.title.replace(/\*/g, '')}**` });
    childIds.push('title');
  }
  spec.sections.forEach((section, index) => {
    const id = `s${index}`;
    const base = `/${id}`;
    childIds.push(id);
    components.push(sectionComponent(id, base, section, data));
  });
  components.push({ id: 'body', component: 'Column', children: childIds });
  if (spec.card === false) {
    components.push({ id: 'root', component: 'Column', children: ['body'] });
  } else {
    components.push({ id: 'root', component: 'Card', child: 'body' });
  }
  return [
    {
      version: A2UI_PROTOCOL_VERSION,
      createSurface: { surfaceId: spec.surfaceId, catalogId: IFC_CATALOG_ID, components, dataModel: data },
    },
  ];
}

function sectionComponent(id: string, base: string, section: SectionSpec, data: Record<string, unknown>): Component {
  const key = base.slice(1);
  switch (section.kind) {
    case 'text':
      return compact({ id, component: 'Text', text: section.text, variant: section.variant });
    case 'callout':
      return compact({ id, component: 'Callout', text: section.text, tone: section.tone, title: section.title });
    case 'stats': {
      const values: Record<string, number> = {};
      const items = section.items.map((item, i) => {
        if (item.value !== undefined) values[`v${i}`] = item.value;
        return compact({
          label: item.label,
          query: item.query,
          aggregate: item.aggregate,
          path: item.path,
          value: item.value !== undefined ? bind(`${base}/v${i}`) : undefined,
          unit: item.unit,
          tone: item.tone,
        });
      });
      if (Object.keys(values).length) data[key] = values;
      return { id, component: 'StatGroup', items };
    }
    case 'table':
      if (section.rows) data[key] = { rows: section.rows };
      return compact({
        id,
        component: 'EntityTable',
        columns: section.columns,
        query: section.query,
        rows: section.rows ? bind(`${base}/rows`) : undefined,
        title: section.title,
        groupBy: section.groupBy,
        sort: section.sort,
        maxRows: section.maxRows,
      });
    case 'list':
      if (section.refs) data[key] = { refs: section.refs };
      return compact({
        id,
        component: 'EntityList',
        query: section.query,
        refs: section.refs ? bind(`${base}/refs`) : undefined,
        title: section.title,
        label: section.label,
      });
    case 'chart':
      if (section.data) data[key] = { data: section.data };
      return compact({
        id,
        component: 'GroupChart',
        groupBy: section.groupBy,
        query: section.query,
        kind: section.chart,
        aggregate: section.aggregate,
        path: section.path,
        data: section.data ? bind(`${base}/data`) : undefined,
        title: section.title,
      });
    case 'legend':
      if (section.data) data[key] = { data: section.data };
      return compact({ id, component: 'ColorLegend', by: section.by, query: section.query, data: section.data ? bind(`${base}/data`) : undefined, title: section.title, apply: section.apply });
    case 'actions':
      if (section.refs) data[key] = { refs: section.refs };
      return compact({
        id,
        component: 'ActionBar',
        actions: section.actions,
        query: section.query,
        refs: section.refs ? bind(`${base}/refs`) : undefined,
        color: section.color,
        followUps: section.followUps,
      });
    case 'entity':
      return compact({ id, component: 'EntityCard', entity: section.entity, sections: section.sections });
  }
}
