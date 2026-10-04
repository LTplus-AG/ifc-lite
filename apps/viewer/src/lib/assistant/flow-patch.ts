/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FlowNode } from '@ifc-lite/flow';

export type FlowPatchOperation =
  | { op: 'addNode'; alias: string; type: string; pos: [number, number] }
  | { op: 'removeNode'; node: string }
  | { op: 'moveNode'; node: string; pos: [number, number] }
  | { op: 'setParam'; node: string; param: string; value: unknown }
  | { op: 'unsetParam'; node: string; param: string }
  | { op: 'updateNode'; node: string; patch: Partial<Pick<FlowNode, 'label' | 'lacing' | 'tracking' | 'trackingKey'>> }
  | { op: 'connect'; from: [string, string]; to: [string, string] }
  | { op: 'disconnect'; to: [string, string] }
  | { op: 'rename'; name: string };
export interface FlowPatch { version: 1; kind: 'flow.patch'; operations: FlowPatchOperation[] }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const pair = (value: unknown): value is [string, string] => Array.isArray(value) && value.length === 2 && value.every(string);
const position = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2
  && value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100_000);
function fields(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

/** Bound every JSON value before passing it to native graph validation. */
export function isBoundedFlowJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  let work = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++work > 2500 || item.depth > 8) return false;
    if (typeof item.value === 'number' && !Number.isFinite(item.value)) return false;
    if (['function', 'symbol', 'bigint'].includes(typeof item.value)) return false;
    if (typeof item.value === 'string' && item.value.length > 8000) return false;
    if (item.value && typeof item.value === 'object') {
      if (!Array.isArray(item.value) && Object.getPrototypeOf(item.value) !== Object.prototype) return false;
      for (const [key, child] of Object.entries(item.value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) return false;
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return true;
}

/** A complete envelope only: never promote a partial response or executable code. */
export function parseFlowPatch(text: string): FlowPatch {
  if (text.length > 48_000) throw new Error('Flow patch exceeds the text limit');
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const raw: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
  if (!isBoundedFlowJson(raw) || !record(raw) || !fields(raw, ['version', 'kind', 'operations'])
    || raw.version !== 1 || raw.kind !== 'flow.patch' || !Array.isArray(raw.operations)
    || !raw.operations.length || raw.operations.length > 50) throw new Error('Invalid bounded Flow patch envelope');
  for (const value of raw.operations) {
    if (!record(value)) throw new Error('Invalid Flow operation');
    const valid = value.op === 'addNode' ? fields(value, ['op', 'alias', 'type', 'pos']) && string(value.alias) && string(value.type) && position(value.pos)
      : value.op === 'removeNode' ? fields(value, ['op', 'node']) && string(value.node)
      : value.op === 'moveNode' ? fields(value, ['op', 'node', 'pos']) && string(value.node) && position(value.pos)
      : value.op === 'setParam' ? fields(value, ['op', 'node', 'param', 'value']) && string(value.node) && string(value.param)
      : value.op === 'unsetParam' ? fields(value, ['op', 'node', 'param']) && string(value.node) && string(value.param)
      : value.op === 'connect' ? fields(value, ['op', 'from', 'to']) && pair(value.from) && pair(value.to)
      : value.op === 'disconnect' ? fields(value, ['op', 'to']) && pair(value.to)
      : value.op === 'rename' ? fields(value, ['op', 'name']) && string(value.name)
      : value.op === 'updateNode' ? fields(value, ['op', 'node', 'patch']) && string(value.node) && record(value.patch)
        && Object.keys(value.patch).length > 0 && Object.keys(value.patch).every(key => ['label', 'lacing', 'tracking', 'trackingKey'].includes(key))
      : false;
    if (!valid) throw new Error(`Invalid Flow operation: ${String(value.op)}`);
  }
  return raw as unknown as FlowPatch;
}
