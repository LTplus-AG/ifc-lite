/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renderer implementations of the IFC catalog functions, bound to a viewer
 * host, behind one policy gate. `IFC_FUNCTION_POLICY` decides; this module only
 * enforces: a `file` function (exportCsv) runs from a user gesture only, and an
 * agent may call only what the table marks agent-callable.
 */

import {
  IFC_FUNCTION_POLICY,
  isIfcFunction,
  parseRefs,
  type IfcFunctionName,
  type WireEntityRef,
} from '@ifc-lite/a2ui';
import { escapeCsvCell } from '@ifc-lite/export';
import { downloadFile } from '@/lib/export/download';
import type { A2uiViewerHost } from './host.js';
import { aggregate, aggregatePool, evaluateQuery, FieldReader } from './query-eval.js';

export interface CallContext {
  caller: 'renderer' | 'agent';
  /** True only inside a user gesture (a click handler, an activated action). */
  userActivated: boolean;
}

export class PolicyRefusal extends Error {
  constructor(readonly fn: string, reason: string) {
    super(`${fn}: ${reason}`);
    this.name = 'PolicyRefusal';
  }
}

export function assertAllowed(name: string, ctx: CallContext): asserts name is IfcFunctionName {
  if (!isIfcFunction(name)) throw new PolicyRefusal(name, 'not an IFC catalog function');
  const policy = IFC_FUNCTION_POLICY[name];
  if (ctx.caller === 'agent' && !policy.agentCallable) throw new PolicyRefusal(name, 'the agent may not call this function');
  if (policy.userActivation && !ctx.userActivated) throw new PolicyRefusal(name, 'runs only from a user click');
}

export interface Target {
  refs: WireEntityRef[];
  /** Model ids the target named that are not loaded; their refs are dropped, and the UI says so. */
  unloadedModels: string[];
}

/** Resolve `{refs?, query?}` to loaded refs. Refs to unloaded models are inert. */
export function resolveTarget(host: A2uiViewerHost, args: { refs?: unknown; query?: unknown }): Target {
  const loaded = new Set(host.loadedModelIds());
  const unloaded = new Set<string>();
  const out = new Map<string, WireEntityRef>();
  for (const ref of parseRefs(args.refs)) {
    if (!loaded.has(ref.modelId)) unloaded.add(ref.modelId);
    else out.set(`${ref.modelId}:${ref.expressId}`, ref);
  }
  if (args.query !== undefined && args.query !== null) {
    const result = evaluateQuery(host, args.query);
    if (result.unloadedModel) unloaded.add(result.unloadedModel);
    for (const row of result.rows) out.set(row.key, row.ref);
  }
  return { refs: [...out.values()], unloadedModels: [...unloaded] };
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export const DEFAULT_HIGHLIGHT = '#e5484d';

export function safeColor(value: unknown): string {
  return typeof value === 'string' && HEX.test(value.trim()) ? value.trim() : DEFAULT_HIGHLIGHT;
}

export interface CsvColumn {
  path: string;
  label?: string;
}

const DEFAULT_CSV_COLUMNS: CsvColumn[] = [
  { path: 'name' }, { path: 'type' }, { path: 'globalId' }, { path: 'storey' }, { path: 'modelId' },
];

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : typeof value === 'number' && !Number.isFinite(value) ? '' : String(value);
  return escapeCsvCell(text, { delimiter: ',' });
}

/** Build the CSV of a target. Every cell goes through the shared formula-injection guard (CWE-1236). */
export function entitiesCsv(host: A2uiViewerHost, refs: WireEntityRef[], columns: CsvColumn[] = DEFAULT_CSV_COLUMNS): string {
  const reader = new FieldReader(host);
  const cols = columns.length ? columns : DEFAULT_CSV_COLUMNS;
  const lines = [cols.map((c) => csvCell(c.label ?? c.path)).join(',')];
  for (const ref of refs) {
    const entity = host.entity(ref);
    if (entity) lines.push(cols.map((c) => csvCell(reader.value(entity, c.path))).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Run one IFC function. Every caller (catalog function, component button,
 * agent call) comes through here, so the policy cannot be bypassed by picking
 * a different entry point.
 */
export function runIfcFunction(host: A2uiViewerHost, name: string, args: Record<string, unknown>, ctx: CallContext): unknown {
  assertAllowed(name, ctx);
  switch (name) {
    case 'select': return host.select(resolveTarget(host, args).refs);
    case 'isolate': return host.isolate(resolveTarget(host, args).refs);
    case 'hide': return host.hide(resolveTarget(host, args).refs);
    case 'show': return host.show(resolveTarget(host, args).refs);
    case 'flyTo': return host.flyTo(resolveTarget(host, args).refs);
    case 'colorize': return host.colorize([{ refs: resolveTarget(host, args).refs, color: safeColor(args.color) }]);
    case 'resetView': return host.resetView();
    case 'getSelection': return host.getSelection().map((r) => `${r.modelId}:${r.expressId}`);
    case 'countEntities': return aggregatePool(evaluateQuery(host, args.query)).length;
    case 'sumQuantity': {
      const result = evaluateQuery(host, args.query);
      return aggregate(new FieldReader(host), aggregatePool(result), 'sum', typeof args.path === 'string' ? args.path : undefined) ?? 0;
    }
    case 'exportCsv': {
      const { refs } = resolveTarget(host, args);
      const columns = Array.isArray(args.columns) ? (args.columns as CsvColumn[]).filter((c) => typeof c?.path === 'string') : undefined;
      downloadFile(entitiesCsv(host, refs, columns), 'ifc-entities.csv', 'text/csv;charset=utf-8');
      return undefined;
    }
  }
}
