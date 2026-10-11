/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isRecord, onlyKeys, requiredText } from '@/lib/check-authoring/proposal-json';

export const COST_OPS = ['cost.schedule.create', 'cost.item.create', 'cost.value.create', 'cost.quantity.create',
  'cost.items.nest', 'cost.schedule.assign', 'cost.item.assign', 'cost.item.values', 'cost.remove'] as const;
export type CostOpName = typeof COST_OPS[number];
export type CostRef = number | { ref: string };
export interface CostOperation {
  op: CostOpName;
  ref?: string;
  params?: Record<string, unknown>;
  target?: CostRef;
  related?: CostRef[];
  detach?: boolean;
}
export interface CostProposal {
  version: 1;
  kind: 'cost.graph';
  title: string;
  modelId: string;
  expected: unknown;
  operations: CostOperation[];
}
const paramKeys = {
  'cost.schedule.create': ['Name', 'Description', 'ObjectType', 'Identification', 'PredefinedType', 'Status', 'SubmittedOn', 'UpdateDate'],
  'cost.item.create': ['Name', 'Description', 'ObjectType', 'Identification', 'PredefinedType', 'CostValues', 'CostQuantities'],
  'cost.value.create': ['Name', 'Description', 'AppliedValue', 'AppliedValueRef', 'UnitBasis', 'ApplicableDate', 'FixedUntilDate', 'Category', 'Condition', 'ArithmeticOperator', 'Components'],
  'cost.quantity.create': ['Kind', 'Name', 'Value', 'Description', 'Unit', 'Formula'],
} as const;
const singleRefs = new Set(['AppliedValueRef', 'UnitBasis', 'Unit']);
const listRefs = new Set(['CostValues', 'CostQuantities', 'Components']);
const name = (value: unknown, at: string) => {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error(`${at} requires a short unique reference name`);
  return value;
};
export function costRef(value: unknown, at: string): CostRef {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (isRecord(value)) { onlyKeys(value, ['ref'], at); return { ref: name(value.ref, at) }; }
  throw new Error(`${at} requires a captured native expressId or an earlier operation reference`);
}
function refList(value: unknown, at: string): CostRef[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error(`${at} requires at most 200 explicit references`);
  return value.map((item, index) => costRef(item, `${at}[${index}]`));
}
/** Bound supplied evidence before walking it; snapshots are comparison inputs, never writer instructions. */
export function costSnapshotWork(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let work = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++work > 12000 || item.depth > 20) throw new Error('The complete Cost graph is too large for this review');
    if (Array.isArray(item.value)) {
      if (item.value.length > 1000) throw new Error('The complete Cost graph has too many records');
      for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
    } else if (isRecord(item.value)) {
      const entries = Object.values(item.value);
      if (entries.length > 40) throw new Error('The Cost graph has too many fields');
      for (const child of entries) pending.push({ value: child, depth: item.depth + 1 });
    } else if (item.value !== null && item.value !== undefined && !['string', 'boolean', 'number'].includes(typeof item.value)) throw new Error('The Cost snapshot must contain native JSON evidence');
  }
}
function params(value: unknown, op: keyof typeof paramKeys): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${op} requires explicit native params`);
  onlyKeys(value, paramKeys[op], 'params');
  const parsed: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (singleRefs.has(key)) parsed[key] = costRef(item, key);
    else if (listRefs.has(key)) parsed[key] = refList(item, key);
    else if (key === 'AppliedValue') {
      if (!isRecord(item)) throw new Error('AppliedValue requires explicit Type and Value');
      onlyKeys(item, ['Type', 'Value'], 'AppliedValue');
      if (typeof item.Type !== 'string' || typeof item.Value !== 'number' || !Number.isFinite(item.Value)) throw new Error('AppliedValue requires an explicit finite typed IFC measure');
      parsed[key] = { Type: item.Type, Value: item.Value };
    } else if (key === 'Value') {
      if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error('The explicitly supplied quantity Value must be finite');
      parsed[key] = item;
    } else {
      if (typeof item !== 'string' || item.length > 2000 || Array.from(item).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error(`${key} requires bounded native IFC text`);
      parsed[key] = item;
    }
  }
  if (op !== 'cost.value.create' && (typeof parsed.Name !== 'string' || !parsed.Name.length)) throw new Error(`${op} requires Name`);
  if (op === 'cost.quantity.create' && (typeof parsed.Kind !== 'string' || typeof parsed.Value !== 'number')) throw new Error('Quantity requires native Kind and explicit Value');
  return parsed;
}
export function declaresCostGraph(content: string): boolean { return /"kind"\s*:\s*"cost\.graph"/.test(content); }
export function parseCostProposal(content: string): CostProposal {
  if (content.length > 100000) throw new Error('The Cost proposal is too large');
  const trimmed = content.trim(), fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const value: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'cost.graph') throw new Error('Expected a version 1 Cost graph proposal');
  onlyKeys(value, ['version', 'kind', 'title', 'modelId', 'expected', 'operations'], 'Cost proposal');
  if (!isRecord(value.expected)) throw new Error('Attach the complete current native Cost snapshot as expected');
  costSnapshotWork(value.expected);
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > 200) throw new Error('Choose 1..200 explicit native Cost operations');
  const refs = new Set<string>();
  let referenceWork = 0;
  const validateRef = (ref: CostRef) => {
    if (++referenceWork > 200) throw new Error('The Cost proposal exceeds 200 operation references');
    if (typeof ref !== 'number' && !refs.has(ref.ref)) throw new Error('An operation reference must name an earlier approved operation');
  };
  const operations = value.operations.map((raw): CostOperation => {
    if (!isRecord(raw) || !COST_OPS.includes(raw.op as CostOpName)) throw new Error('Unsupported native Cost operation');
    const op = raw.op as CostOpName;
    const create = op in paramKeys;
    onlyKeys(raw, create ? ['op', 'ref', 'params'] : op === 'cost.remove' ? ['op', 'target', 'detach'] : ['op', 'target', 'related', 'ref'], op);
    const operation: CostOperation = create ? { op, params: params(raw.params, op as keyof typeof paramKeys) }
      : { op, target: costRef(raw.target, 'target'), ...(op !== 'cost.remove' ? { related: refList(raw.related, 'related') } : {}) };
    if (operation.target !== undefined) validateRef(operation.target);
    for (const ref of operation.related ?? []) validateRef(ref);
    for (const [key, item] of Object.entries(operation.params ?? {})) {
      if (singleRefs.has(key)) validateRef(item as CostRef);
      if (listRefs.has(key)) for (const ref of item as CostRef[]) validateRef(ref);
    }
    if (raw.detach !== undefined) { if (typeof raw.detach !== 'boolean') throw new Error('detach must be an explicit boolean'); operation.detach = raw.detach; }
    if (raw.ref !== undefined) {
      operation.ref = name(raw.ref, 'ref');
      if (refs.has(operation.ref) || op === 'cost.item.values') throw new Error('Only native creations may introduce a unique operation reference');
      refs.add(operation.ref);
    }
    return operation;
  });
  return { version: 1, kind: 'cost.graph', title: requiredText(value, 'title', 'Cost proposal', 200), modelId: requiredText(value, 'modelId', 'Cost proposal', 200), expected: value.expected, operations };
}
export const COST_GRAPH_GUIDANCE = `Explicitly supplied costs use a separate version 1 kind "cost.graph", title, one modelId, complete nativeCost.expected and operations. Preserve exact IFC PascalCase params and original typed AppliedValue {Type,Value}, quantity Kind/Value/Unit, Components and UnitBasis. Never invent prices, currency, rates or currency conversion. Supported operations: cost.schedule.create, cost.item.create, cost.value.create, cost.quantity.create (params, optional unique ref); cost.items.nest, cost.schedule.assign, cost.item.assign, cost.item.values (target and related refs); cost.remove (target, explicit optional detach). Native refs are expressIds present in expected.records, or {ref:"earlierName"} for an earlier approved operation. Full snapshots are required, never use sampled/unavailable evidence. Selection source and explicit selection attachment supply nativeCost for that model and selected target. Rich source expectedJsonParts are exact native JSON: join all parts without separators and parse JSON as expected; an explicit attachment carries expected directly. Refuse missing, truncated or omitted parts, unavailable status or rowProjectionTruncated, never fill missing fields. Proposal only: user reviews native graph changes and approves operations before Apply; no auto-run, geometry units or inferred estimate.`;
