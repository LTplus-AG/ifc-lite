/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isInstantiable, type IfcDataStore } from '@ifc-lite/parser';
import { entityForPath, pathForEntity } from './entity-paths';

const PATH_KEY = 'ifc-lite::entityPath';
const STEP_REFERENCE = /^#([1-9]\d*)$/;
const MAX_VALUE_NODES = 10_000;
const MAX_VALUE_DEPTH = 256;

export interface ReferenceTraversalBudget { remainingNodes: number }

function scalarTypedMarker(value: object): boolean {
  if (Array.isArray(value)) return false;
  const typed = (value as { typed?: unknown }).typed;
  if (!typed || typeof typed !== 'object' || Array.isArray(typed)) return false;
  const marker = typed as Record<string, unknown>;
  return typeof marker.type === 'string' && 'value' in marker && !isInstantiable(marker.type);
}

function assertValueBudget(nodes: number, depth: number, budget?: ReferenceTraversalBudget): void {
  if (nodes > MAX_VALUE_NODES) {
    throw new Error(`collaboration attribute value exceeds ${MAX_VALUE_NODES} nodes`);
  }
  if (depth > MAX_VALUE_DEPTH) {
    throw new Error(`collaboration attribute value exceeds depth ${MAX_VALUE_DEPTH}`);
  }
  if (budget && --budget.remainingNodes < 0) {
    throw new Error('collaboration source reference graph exceeds its traversal work budget');
  }
}

export function referencedExpressIds(
  value: unknown, allowReferences: boolean, ids = new Set<number>(), budget?: ReferenceTraversalBudget,
): Set<number> {
  if (!allowReferences) return ids;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const { value: item, depth } = pending.pop()!;
    assertValueBudget(++nodes, depth, budget);
    if (typeof item === 'string') {
      const match = STEP_REFERENCE.exec(item);
      if (match) ids.add(Number(match[1]));
    } else if (item && typeof item === 'object' && !visited.has(item)) {
      visited.add(item);
      if (scalarTypedMarker(item)) continue;
      for (const child of Array.isArray(item) ? item : Object.values(item)) {
        pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return ids;
}

interface TransformFrame {
  value: unknown;
  depth: number;
  assign(value: unknown): void;
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/** Replace sender-local STEP references with stable room paths. */
export function encodeRoomAttributeValue(
  store: IfcDataStore,
  value: unknown,
  allowReferences: boolean,
  resolvePath: (expressId: number) => string | null = expressId => pathForEntity(store, expressId),
  budget?: ReferenceTraversalBudget,
): unknown {
  if (!allowReferences) return value;
  let encoded: unknown;
  const pending: TransformFrame[] = [{ value, depth: 0, assign: next => { encoded = next; } }];
  let nodes = 0;
  while (pending.length > 0) {
    const frame = pending.pop()!;
    assertValueBudget(++nodes, frame.depth, budget);
    const item = frame.value;
    if (typeof item === 'string') {
      const match = STEP_REFERENCE.exec(item);
      const path = match ? resolvePath(Number(match[1])) : null;
      frame.assign(path ? { [PATH_KEY]: path } : item);
    } else if (Array.isArray(item)) {
      const output = new Array<unknown>(item.length);
      frame.assign(output);
      for (let index = item.length - 1; index >= 0; index -= 1) {
        pending.push({ value: item[index], depth: frame.depth + 1, assign: next => { output[index] = next; } });
      }
    } else if (item && typeof item === 'object' && !scalarTypedMarker(item)) {
      const output: Record<string, unknown> = {};
      frame.assign(output);
      const entries = Object.entries(item);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index];
        pending.push({ value: child, depth: frame.depth + 1, assign: next => setOwn(output, key, next) });
      }
    } else {
      frame.assign(item);
    }
  }
  return encoded;
}

/** Resolve stable room paths into this recipient's local STEP ID space. */
export function decodeRoomAttributeValue(store: IfcDataStore, value: unknown):
  { ok: true; value: unknown } | { ok: false; reason: string } {
  let decoded: unknown;
  const pending: TransformFrame[] = [{ value, depth: 0, assign: next => { decoded = next; } }];
  let nodes = 0;
  try {
    while (pending.length > 0) {
      const frame = pending.pop()!;
      assertValueBudget(++nodes, frame.depth);
      const item = frame.value;
      if (Array.isArray(item)) {
        const output = new Array<unknown>(item.length);
        frame.assign(output);
        for (let index = item.length - 1; index >= 0; index -= 1) {
          pending.push({ value: item[index], depth: frame.depth + 1, assign: next => { output[index] = next; } });
        }
      } else if (item && typeof item === 'object' && Object.keys(item).length === 1 && PATH_KEY in item) {
        const path = (item as Record<string, unknown>)[PATH_KEY];
        if (typeof path !== 'string') return { ok: false, reason: 'invalid room reference' };
        const id = entityForPath(store, path);
        if (id === null) return { ok: false, reason: `unresolved room reference: ${path}` };
        frame.assign(`#${id}`);
      } else if (item && typeof item === 'object' && !scalarTypedMarker(item)) {
        const output: Record<string, unknown> = {};
        frame.assign(output);
        const entries = Object.entries(item);
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const [key, child] = entries[index];
          pending.push({ value: child, depth: frame.depth + 1, assign: next => setOwn(output, key, next) });
        }
      } else {
        frame.assign(item);
      }
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, value: decoded };
}
