/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `model.*` read nodes. Every one is `reads: 'model'` so it is memoised
 * against the model revision, and every one carries `model.read`.
 *
 * Entities are handles: a node reads exactly what it returns through the
 * SDK and nothing is copied into the graph.
 */

import type { EntityRef, GroupKey, Scalar } from '@ifc-lite/flow';
import {
  ENTITY_GROUP,
  ENTITY_ITEM,
  ENTITY_LIST,
  SCALAR_ITEM,
  entityOf,
  requireCapability,
  toRef,
  toSdkRef,
  type Ctx,
  type FlowNodeDef,
} from './host.js';

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`"${name}" must be a non-empty string`);
  return v;
};

function query(ctx: Ctx, modelId: unknown) {
  const q = ctx.host.bim.query();
  const id = typeof modelId === 'string' && modelId.length > 0 ? modelId : ctx.host.defaultModelId;
  return id ? q.model(id) : q;
}

/**
 * Optional model id wired from `model.openFromSource`: it wins over the
 * `model` param, and the edge makes the read run after the model is open.
 */
const MODEL_ID_INPUT = { name: 'modelId', type: SCALAR_ITEM, optional: true, nullable: true } as const;

export const modelNodes: FlowNodeDef[] = [
  {
    type: 'model.select',
    title: 'Select',
    category: 'model',
    doc: 'Entities matching an IfcOpenShell-style selector, e.g. `IfcWall, Pset_WallCommon.IsExternal=TRUE`.',
    inputs: [MODEL_ID_INPUT],
    outputs: [{ name: 'entities', type: ENTITY_LIST }],
    params: [
      { name: 'selector', kind: 'string', default: 'IfcWall' },
      { name: 'model', kind: 'string', doc: 'Model id; the default model when empty.' },
    ],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i, p) => {
      requireCapability(ctx, 'model.read');
      return { entities: query(ctx, i.modelId ?? p.model).select(str(p.selector, 'selector')).toArray().map(toRef) };
    },
  },
  {
    type: 'model.byType',
    title: 'By type',
    category: 'model',
    inputs: [MODEL_ID_INPUT],
    outputs: [{ name: 'entities', type: ENTITY_LIST }],
    params: [
      { name: 'type', kind: 'string', default: 'IfcWall' },
      { name: 'model', kind: 'string' },
    ],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i, p) => {
      requireCapability(ctx, 'model.read');
      return { entities: query(ctx, i.modelId ?? p.model).byType(str(p.type, 'type')).toArray().map(toRef) };
    },
  },
  {
    type: 'model.attribute',
    title: 'Attribute',
    category: 'model',
    doc: 'Name, Type, Description, ObjectType or GlobalId of an entity.',
    inputs: [{ name: 'entity', type: ENTITY_ITEM }],
    outputs: [{ name: 'value', type: SCALAR_ITEM }],
    params: [{ name: 'attribute', kind: 'enum', default: 'Name', options: ['Name', 'Type', 'Description', 'ObjectType', 'GlobalId'] }],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i, p) => {
      requireCapability(ctx, 'model.read');
      const e = entityOf(ctx, i.entity as EntityRef);
      switch (p.attribute) {
        case 'Name': return { value: e.name };
        case 'Type': return { value: e.type };
        case 'Description': return { value: e.description };
        case 'ObjectType': return { value: e.objectType };
        case 'GlobalId': return { value: e.globalId };
        default: throw new Error(`unknown attribute "${String(p.attribute)}"`);
      }
    },
  },
  {
    type: 'model.property',
    title: 'Property',
    category: 'model',
    inputs: [{ name: 'entity', type: ENTITY_ITEM }],
    outputs: [{ name: 'value', type: SCALAR_ITEM }],
    params: [
      { name: 'pset', kind: 'string', default: 'Pset_WallCommon' },
      { name: 'property', kind: 'string', default: 'IsExternal' },
    ],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i, p) => {
      requireCapability(ctx, 'model.read');
      return { value: ctx.host.bim.property(toSdkRef(ctx, i.entity as EntityRef), str(p.pset, 'pset'), str(p.property, 'property')) as Scalar };
    },
  },
  {
    type: 'model.quantity',
    title: 'Quantity',
    category: 'model',
    inputs: [{ name: 'entity', type: ENTITY_ITEM }],
    outputs: [{ name: 'value', type: SCALAR_ITEM }],
    params: [
      { name: 'qset', kind: 'string', doc: 'Optional quantity set name.' },
      { name: 'quantity', kind: 'string', default: 'NetVolume' },
    ],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i, p) => {
      requireCapability(ctx, 'model.read');
      const ref = toSdkRef(ctx, i.entity as EntityRef);
      const q = str(p.quantity, 'quantity');
      const value = typeof p.qset === 'string' && p.qset.length > 0 ? ctx.host.bim.quantity(ref, p.qset, q) : ctx.host.bim.quantity(ref, q);
      return { value };
    },
  },
  {
    type: 'model.related',
    title: 'Related',
    category: 'model',
    doc: 'Entities linked by an IFC relationship, e.g. IfcRelVoidsElement forward = openings of a wall.',
    inputs: [{ name: 'entity', type: ENTITY_ITEM }],
    outputs: [{ name: 'related', type: ENTITY_LIST }],
    params: [
      { name: 'relationship', kind: 'string', default: 'IfcRelVoidsElement' },
      { name: 'direction', kind: 'enum', default: 'forward', options: ['forward', 'inverse'] },
    ],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i, p) => {
      requireCapability(ctx, 'model.read');
      const dir = p.direction === 'inverse' ? 'inverse' : 'forward';
      return { related: ctx.host.bim.related(toSdkRef(ctx, i.entity as EntityRef), str(p.relationship, 'relationship'), dir).map(toRef) };
    },
  },
  {
    type: 'model.storey',
    title: 'Storey',
    category: 'model',
    inputs: [{ name: 'entity', type: ENTITY_ITEM }],
    outputs: [{ name: 'storey', type: ENTITY_ITEM }],
    params: [],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i) => {
      requireCapability(ctx, 'model.read');
      const s = ctx.host.bim.storey(toSdkRef(ctx, i.entity as EntityRef));
      return { storey: s ? toRef(s) : null };
    },
  },
  {
    type: 'model.contains',
    title: 'Contained elements',
    category: 'model',
    inputs: [{ name: 'container', type: ENTITY_ITEM }],
    outputs: [{ name: 'entities', type: ENTITY_LIST }],
    params: [],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i) => {
      requireCapability(ctx, 'model.read');
      return { entities: ctx.host.bim.contains(toSdkRef(ctx, i.container as EntityRef)).map(toRef) };
    },
  },
  {
    type: 'model.groupByStorey',
    title: 'Group by storey',
    category: 'model',
    doc: 'Entities under their storey GlobalId; entities with no storey go under "".',
    inputs: [{ name: 'entities', type: ENTITY_LIST }],
    outputs: [{ name: 'group', type: ENTITY_GROUP }],
    params: [],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i) => {
      requireCapability(ctx, 'model.read');
      const group = new Map<GroupKey, EntityRef[]>();
      for (const ref of i.entities as EntityRef[]) {
        const s = ctx.host.bim.storey(toSdkRef(ctx, ref));
        const key = s?.globalId ?? '';
        (group.get(key) ?? group.set(key, []).get(key)!).push(ref);
      }
      return { group };
    },
  },
  {
    type: 'model.groupByType',
    title: 'Group by type',
    category: 'model',
    inputs: [{ name: 'entities', type: ENTITY_LIST }],
    outputs: [{ name: 'group', type: ENTITY_GROUP }],
    params: [],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i) => {
      requireCapability(ctx, 'model.read');
      const group = new Map<GroupKey, EntityRef[]>();
      for (const ref of i.entities as EntityRef[]) {
        const key = entityOf(ctx, ref).type;
        (group.get(key) ?? group.set(key, []).get(key)!).push(ref);
      }
      return { group };
    },
  },
];
