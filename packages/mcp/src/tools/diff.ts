/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Diff & comparison tools (spec §7.8).
 *
 * Both inputs reference loaded models by id; if you want to diff against an
 * on-disk file, call `model_load` first.
 */

import { EntityNode } from '@ifc-lite/query';
import { IFC_ENTITY_NAMES } from '@ifc-lite/data';
import type { Tool } from './types.js';
import { okResult } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

function resolveTwo(ctx: { registry: { get(id: string): { id: string; store: import('@ifc-lite/parser').IfcDataStore; bim: import('@ifc-lite/sdk').BimContext } | null } }, a: string, b: string) {
  const left = ctx.registry.get(a);
  const right = ctx.registry.get(b);
  if (!left || !right) {
    throw new ToolExecutionError({
      code: ToolErrorCode.MODEL_NOT_FOUND,
      message: `Both models must be loaded; missing: ${[!left && a, !right && b].filter(Boolean).join(', ')}`,
    });
  }
  return { left, right };
}

const modelDiff: Tool = {
  name: 'model_diff',
  description: 'Compare two loaded models. Reports added/removed entities by GlobalId and per-type count deltas.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'string', description: 'model_id of base.' },
      b: { type: 'string', description: 'model_id of head.' },
      by_entity: { type: 'boolean', default: true, description: 'Include per-entity GlobalId additions/removals.' },
    },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const { left, right } = resolveTwo(ctx, input.a as string, input.b as string);
    // Type-level diff
    const types1 = new Map<string, number>();
    const types2 = new Map<string, number>();
    for (const [type, ids] of left.store.entityIndex.byType) types1.set(type, ids.length);
    for (const [type, ids] of right.store.entityIndex.byType) types2.set(type, ids.length);
    const allTypes = new Set([...types1.keys(), ...types2.keys()]);
    const typeDiffs: Array<{ type: string; left: number; right: number; delta: number }> = [];
    for (const t of allTypes) {
      const c1 = types1.get(t) ?? 0;
      const c2 = types2.get(t) ?? 0;
      if (c1 !== c2) typeDiffs.push({ type: IFC_ENTITY_NAMES[t] ?? t, left: c1, right: c2, delta: c2 - c1 });
    }
    typeDiffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    let entityDiff: { added: string[]; removed: string[]; common: number } | null = null;
    if ((input.by_entity as boolean | undefined) ?? true) {
      const gids1 = new Set<string>();
      const gids2 = new Set<string>();
      for (const [, ids] of left.store.entityIndex.byType) {
        for (const id of ids) {
          const node = new EntityNode(left.store, id);
          if (node.globalId) gids1.add(node.globalId);
        }
      }
      for (const [, ids] of right.store.entityIndex.byType) {
        for (const id of ids) {
          const node = new EntityNode(right.store, id);
          if (node.globalId) gids2.add(node.globalId);
        }
      }
      const added: string[] = [];
      const removed: string[] = [];
      let common = 0;
      for (const g of gids1) (gids2.has(g) ? common++ : removed.push(g));
      for (const g of gids2) if (!gids1.has(g)) added.push(g);
      entityDiff = { added, removed, common };
    }

    return okResult(
      `Diff ${input.a}→${input.b}: ${typeDiffs.length} type changes${entityDiff ? `, +${entityDiff.added.length}/-${entityDiff.removed.length} entities` : ''}.`,
      { typeDiffs, entityDiff },
    );
  },
};

const quantityDiff: Tool = {
  name: 'quantity_diff',
  description: 'Per-entity-type quantity comparison between two models, optionally grouped by storey.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: { type: 'string' },
      type: { type: 'string', default: 'IfcWall' },
      quantity: { type: 'string', default: 'Volume' },
      group_by: { type: 'string', enum: ['storey', 'type'], default: 'type' },
    },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const { left, right } = resolveTwo(ctx, input.a as string, input.b as string);
    const type = (input.type as string | undefined) ?? 'IfcWall';
    const qName = (input.quantity as string | undefined) ?? 'Volume';

    const aggregate = (model: typeof left): Map<string, { count: number; total: number }> => {
      const out = new Map<string, { count: number; total: number }>();
      for (const e of model.bim.query().byType(type).toArray()) {
        const key = (input.group_by as string | undefined) === 'storey'
          ? (new EntityNode(model.store, e.ref.expressId).storey()?.name ?? '(none)')
          : e.type;
        let value: number | null = null;
        for (const qset of model.bim.quantities(e.ref)) {
          for (const q of qset.quantities) {
            if (q.name.endsWith(qName)) { value = q.value; break; }
          }
          if (value !== null) break;
        }
        const slot = out.get(key) ?? { count: 0, total: 0 };
        slot.count++;
        if (value != null) slot.total += value;
        out.set(key, slot);
      }
      return out;
    };

    const left1 = aggregate(left);
    const right1 = aggregate(right);
    const groups = new Set([...left1.keys(), ...right1.keys()]);
    const rows: Array<{ key: string; left: number; right: number; delta: number; deltaPct: number | null }> = [];
    for (const k of groups) {
      const l = left1.get(k)?.total ?? 0;
      const r = right1.get(k)?.total ?? 0;
      const delta = r - l;
      const pct = l === 0 ? null : (delta / l) * 100;
      rows.push({ key: k, left: l, right: r, delta, deltaPct: pct });
    }
    rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return okResult(
      `${rows.length} group(s) compared (${type}.${qName}).`,
      { type, quantity: qName, groupBy: input.group_by ?? 'type', rows },
    );
  },
};

export const diffTools: Tool[] = [modelDiff, quantityDiff];
