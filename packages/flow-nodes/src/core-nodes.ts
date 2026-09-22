/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `core.*` — values, arithmetic, and the total set of restructuring nodes.
 *
 * There is deliberately no Path Mapper, Shift Paths or Simplify here: with
 * one keyed level, `groupBy` / `flatten` / `keys` / `lookup` / `wrap` are
 * all the restructuring a graph needs.
 */

import type { GroupKey, Scalar } from '@ifc-lite/flow';
import { ANY_GROUP, ANY_ITEM, ANY_LIST, SCALAR_ITEM, SCALAR_LIST, type FlowNodeDef } from './host.js';

const num = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${name}" must be a finite number, got ${JSON.stringify(v)}`);
  return v;
};

const scalarKey = (v: unknown): GroupKey => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return (v as { globalId?: string }).globalId ?? JSON.stringify(v);
  return String(v);
};

export const coreNodes: FlowNodeDef[] = [
  {
    type: 'core.number',
    title: 'Number',
    category: 'core',
    inputs: [],
    outputs: [{ name: 'value', type: SCALAR_ITEM }],
    params: [{ name: 'value', kind: 'number', default: 0 }],
    capabilities: [],
    run: (_c, _i, p) => ({ value: num(p.value, 'value') }),
  },
  {
    type: 'core.string',
    title: 'Text',
    category: 'core',
    inputs: [],
    outputs: [{ name: 'value', type: SCALAR_ITEM }],
    params: [{ name: 'value', kind: 'string', default: '' }],
    capabilities: [],
    run: (_c, _i, p) => ({ value: String(p.value ?? '') }),
  },
  {
    type: 'core.boolean',
    title: 'Boolean',
    category: 'core',
    inputs: [],
    outputs: [{ name: 'value', type: SCALAR_ITEM }],
    params: [{ name: 'value', kind: 'boolean', default: false }],
    capabilities: [],
    run: (_c, _i, p) => ({ value: p.value === true }),
  },
  {
    type: 'core.list',
    title: 'List',
    category: 'core',
    doc: 'A literal list of scalars (JSON array).',
    inputs: [],
    outputs: [{ name: 'items', type: SCALAR_LIST }],
    params: [{ name: 'items', kind: 'json', default: [] }],
    capabilities: [],
    run: (_c, _i, p) => {
      if (!Array.isArray(p.items)) throw new Error('"items" must be a JSON array');
      return { items: p.items as Scalar[] };
    },
  },
  {
    type: 'core.math',
    title: 'Math',
    category: 'core',
    inputs: [
      { name: 'a', type: SCALAR_ITEM },
      { name: 'b', type: SCALAR_ITEM },
    ],
    outputs: [{ name: 'result', type: SCALAR_ITEM }],
    params: [{ name: 'op', kind: 'enum', default: 'add', options: ['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'pow'] }],
    capabilities: [],
    run: (_c, i, p) => {
      const a = num(i.a, 'a');
      const b = num(i.b, 'b');
      switch (p.op) {
        case 'add': return { result: a + b };
        case 'subtract': return { result: a - b };
        case 'multiply': return { result: a * b };
        case 'divide':
          if (b === 0) throw new Error('division by zero');
          return { result: a / b };
        case 'min': return { result: Math.min(a, b) };
        case 'max': return { result: Math.max(a, b) };
        case 'pow': return { result: a ** b };
        default: throw new Error(`unknown op "${String(p.op)}"`);
      }
    },
  },
  {
    type: 'core.compare',
    title: 'Compare',
    category: 'core',
    doc: 'Compares a with b; an unconnected b is null, so `= (nothing)` tests for a missing value.',
    inputs: [
      { name: 'a', type: SCALAR_ITEM, nullable: true },
      { name: 'b', type: SCALAR_ITEM, nullable: true, optional: true },
    ],
    outputs: [{ name: 'result', type: SCALAR_ITEM }],
    params: [{ name: 'op', kind: 'enum', default: '=', options: ['=', '!=', '<', '<=', '>', '>=', 'contains'] }],
    capabilities: [],
    run: (_c, i, p) => {
      const a = (i.a ?? null) as Scalar;
      const b = (i.b ?? null) as Scalar;
      switch (p.op) {
        case '=': return { result: a === b };
        case '!=': return { result: a !== b };
        case '<': return { result: num(a, 'a') < num(b, 'b') };
        case '<=': return { result: num(a, 'a') <= num(b, 'b') };
        case '>': return { result: num(a, 'a') > num(b, 'b') };
        case '>=': return { result: num(a, 'a') >= num(b, 'b') };
        case 'contains': return { result: String(a ?? '').includes(String(b ?? '')) };
        default: throw new Error(`unknown op "${String(p.op)}"`);
      }
    },
  },
  {
    type: 'core.concat',
    title: 'Join text',
    category: 'core',
    inputs: [{ name: 'parts', type: SCALAR_LIST }],
    outputs: [{ name: 'text', type: SCALAR_ITEM }],
    params: [{ name: 'separator', kind: 'string', default: '' }],
    capabilities: [],
    run: (_c, i, p) => ({ text: (i.parts as Scalar[]).map((v) => (v === null ? '' : String(v))).join(String(p.separator ?? '')) }),
  },
  {
    type: 'core.count',
    title: 'Count',
    category: 'core',
    inputs: [{ name: 'items', type: ANY_LIST }],
    outputs: [{ name: 'count', type: SCALAR_ITEM }],
    params: [],
    capabilities: [],
    run: (_c, i) => ({ count: (i.items as unknown[]).length }),
  },
  {
    type: 'core.sum',
    title: 'Sum',
    category: 'core',
    inputs: [{ name: 'values', type: SCALAR_LIST }],
    outputs: [{ name: 'total', type: SCALAR_ITEM }],
    params: [],
    capabilities: [],
    run: (_c, i) => ({ total: (i.values as Scalar[]).reduce<number>((s, v) => s + (typeof v === 'number' ? v : 0), 0) }),
  },
  {
    type: 'core.filter',
    title: 'Filter',
    category: 'core',
    doc: 'Keep the items whose mask entry is true (shortest of the two lists).',
    inputs: [
      { name: 'items', type: ANY_LIST },
      { name: 'mask', type: SCALAR_LIST },
    ],
    outputs: [
      { name: 'kept', type: ANY_LIST },
      { name: 'dropped', type: ANY_LIST },
    ],
    params: [],
    capabilities: [],
    run: (_c, i) => {
      const items = i.items as unknown[];
      const mask = i.mask as Scalar[];
      const n = Math.min(items.length, mask.length);
      const kept: unknown[] = [];
      const dropped: unknown[] = [];
      for (let k = 0; k < n; k += 1) (mask[k] === true ? kept : dropped).push(items[k]);
      return { kept, dropped };
    },
  },
  {
    type: 'core.wrap',
    title: 'Wrap',
    category: 'core',
    doc: 'One item as a one-element list.',
    inputs: [{ name: 'item', type: ANY_ITEM, nullable: true }],
    outputs: [{ name: 'list', type: ANY_LIST }],
    params: [],
    capabilities: [],
    run: (_c, i) => ({ list: [i.item] }),
  },
  {
    type: 'core.flatten',
    title: 'Flatten',
    category: 'core',
    doc: 'Every branch concatenated into one list, branch order preserved.',
    inputs: [{ name: 'group', type: ANY_GROUP }],
    outputs: [{ name: 'items', type: ANY_LIST }],
    params: [],
    capabilities: [],
    run: (_c, i) => {
      const out: unknown[] = [];
      for (const branch of (i.group as Map<GroupKey, unknown[]>).values()) out.push(...branch);
      return { items: out };
    },
  },
  {
    type: 'core.groupBy',
    title: 'Group by',
    category: 'core',
    doc: 'Items grouped under the matching key (shortest of the two lists). Entities key by GlobalId.',
    inputs: [
      { name: 'items', type: ANY_LIST },
      { name: 'keys', type: ANY_LIST },
    ],
    outputs: [{ name: 'group', type: ANY_GROUP }],
    params: [],
    capabilities: [],
    run: (_c, i) => {
      const items = i.items as unknown[];
      const keys = i.keys as unknown[];
      const group = new Map<GroupKey, unknown[]>();
      const n = Math.min(items.length, keys.length);
      for (let k = 0; k < n; k += 1) {
        const key = scalarKey(keys[k]);
        (group.get(key) ?? group.set(key, []).get(key)!).push(items[k]);
      }
      return { group };
    },
  },
  {
    type: 'core.keys',
    title: 'Keys',
    category: 'core',
    inputs: [{ name: 'group', type: ANY_GROUP }],
    outputs: [{ name: 'keys', type: SCALAR_LIST }],
    params: [],
    capabilities: [],
    run: (_c, i) => ({ keys: [...(i.group as Map<GroupKey, unknown[]>).keys()] }),
  },
  {
    type: 'core.lookup',
    title: 'Lookup',
    category: 'core',
    doc: 'The branch under a key; empty when absent.',
    inputs: [
      { name: 'group', type: ANY_GROUP },
      { name: 'key', type: SCALAR_ITEM },
    ],
    outputs: [{ name: 'items', type: ANY_LIST }],
    params: [],
    capabilities: [],
    run: (_c, i) => ({ items: (i.group as Map<GroupKey, unknown[]>).get(scalarKey(i.key)) ?? [] }),
  },
];
