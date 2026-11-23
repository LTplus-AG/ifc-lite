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
  MAX_QUERY_LIMIT,
  encodeRef,
  isIfcFunction,
  parseRefs,
  type IfcFunctionName,
  type QueryProblem,
  type WireEntityRef,
} from '@ifc-lite/a2ui';
import { escapeCsvCell } from '@ifc-lite/export';
import { downloadFile } from '@/lib/export/download';
import type { A2uiViewerHost } from './host.js';
import { aggregate, aggregatePool, evaluateQuery, FieldReader, type QueryResult } from './query-eval.js';

interface CallContext {
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
  /** Problems in the target's query. A query with problems selects nothing: it would run broader than written. */
  problems: QueryProblem[];
  /** Query matches before the hard ceiling cut them to `refs`; set only when it did. */
  cappedFrom?: number;
}

/** Resolve `{refs?, query?}` to loaded refs. Refs to unloaded models are inert. */
export function resolveTarget(host: A2uiViewerHost, args: { refs?: unknown; query?: unknown }): Target {
  const loaded = new Set(host.loadedModelIds());
  const unloaded = new Set<string>();
  const out = new Map<string, WireEntityRef>();
  for (const ref of parseRefs(args.refs)) {
    if (!loaded.has(ref.modelId)) unloaded.add(ref.modelId);
    else out.set(encodeRef(ref), ref);
  }
  let cappedFrom: number | undefined;
  if (args.query !== undefined && args.query !== null) {
    const result = evaluateQuery(host, args.query);
    if (result.unloadedModel) unloaded.add(result.unloadedModel);
    if (result.problems.length) return { refs: [], unloadedModels: [...unloaded], problems: result.problems };
    // The whole match set, like the stats and charts beside it, up to the hard query ceiling (and the UI says so).
    const pool = aggregatePool(result);
    for (const row of pool.slice(0, MAX_QUERY_LIMIT)) out.set(row.key, row.ref);
    // Counted like `refs`: matches past the ceiling that no explicit ref already covers.
    const dropped = pool.slice(MAX_QUERY_LIMIT).filter((row) => !out.has(row.key)).length;
    if (dropped > 0) cappedFrom = out.size + dropped;
  }
  return { refs: [...out.values()], unloadedModels: [...unloaded], problems: [], ...(cappedFrom !== undefined && { cappedFrom }) };
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const DEFAULT_HIGHLIGHT = '#e5484d';

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

/** A count or sum over a query that has problems or names an unloaded model is refused, not reported as 0. */
function checkAggregate(name: string, result: QueryResult): void {
  if (result.problems.length) throw new PolicyRefusal(name, describeProblems(result.problems));
  if (result.unloadedModel) throw new PolicyRefusal(name, `model ${result.unloadedModel} is not loaded`);
}

function describeProblems(problems: QueryProblem[]): string {
  return `the query has problems, so it would act on more than was asked: ${problems.map((p) => `${p.path || 'query'}: ${p.message}`).join('; ')}`;
}

/** The target's refs, or a refusal naming the query's problems (never a silently broader or empty set). */
function targetRefs(host: A2uiViewerHost, name: string, args: Record<string, unknown>): WireEntityRef[] {
  const target = resolveTarget(host, args);
  if (target.problems.length) throw new PolicyRefusal(name, describeProblems(target.problems));
  return target.refs;
}

/**
 * Reset view clears colours and visibility in the whole viewer. Components
 * holding view state (a legend's applied colours and hidden groups) listen
 * here, so a reset from any surface, button or agent call clears them all.
 */
const viewResetListeners = new Set<() => void>();

export function onViewReset(listener: () => void): () => void {
  viewResetListeners.add(listener);
  return () => { viewResetListeners.delete(listener); };
}

/**
 * Run one IFC function. Every caller (catalog function, component button,
 * agent call) comes through here, so the policy cannot be bypassed by picking
 * a different entry point.
 */
export function runIfcFunction(host: A2uiViewerHost, name: string, args: Record<string, unknown>, ctx: CallContext): unknown {
  assertAllowed(name, ctx);
  switch (name) {
    case 'select': return host.select(targetRefs(host, name, args));
    case 'isolate': return host.isolate(targetRefs(host, name, args));
    case 'hide': return host.hide(targetRefs(host, name, args));
    case 'show': return host.show(targetRefs(host, name, args));
    case 'flyTo': return host.flyTo(targetRefs(host, name, args));
    case 'colorize': return host.colorize([{ refs: targetRefs(host, name, args), color: safeColor(args.color) }]);
    case 'resetView': {
      host.resetView();
      for (const listener of viewResetListeners) listener();
      return undefined;
    }
    case 'getSelection': return host.getSelection().map(encodeRef);
    case 'countEntities': {
      const result = evaluateQuery(host, args.query);
      checkAggregate(name, result);
      return aggregatePool(result).length;
    }
    case 'sumQuantity': {
      const reader = new FieldReader(host);
      const result = evaluateQuery(host, args.query, reader);
      checkAggregate(name, result);
      const path = typeof args.path === 'string' ? args.path : undefined;
      const sum = aggregate(reader, aggregatePool(result), 'sum', path);
      // Matches without a number at the path (a missing or misspelt path) are not a total of 0.
      if (sum === undefined) throw new PolicyRefusal(name, `no matched entity has a number at ${path ?? 'the path (none given)'}`);
      return sum;
    }
    case 'exportCsv': {
      const refs = targetRefs(host, name, args);
      const columns = Array.isArray(args.columns) ? (args.columns as CsvColumn[]).filter((c) => typeof c?.path === 'string') : undefined;
      downloadFile(entitiesCsv(host, refs, columns), 'ifc-entities.csv', 'text/csv;charset=utf-8');
      return undefined;
    }
  }
}
