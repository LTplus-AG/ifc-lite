/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `model.set*` — idempotent writes into the host's change set.
 *
 * Read and write nodes are distinct on purpose (IFCflow's Property node
 * mixed get/set/add/remove behind string params and lost track of what it
 * had done). A property set is naturally idempotent, so these nodes need
 * no tracked set: re-running writes the same value into the same slot.
 *
 * The capability check uses the *actual* pset: `model.mutate:Pset_WallCommon`
 * is what a graph must be granted to write that pset, and a grant for
 * another pset does not pass.
 */

import type { EntityRef, Scalar } from '@ifc-lite/flow';
import { ENTITY_ITEM, SCALAR_ITEM, requireCapability, toSdkRef, type FlowNodeDef } from './host.js';

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`"${name}" must be a non-empty string`);
  return v;
};

export const writeNodes: FlowNodeDef[] = [
  {
    type: 'model.setProperty',
    title: 'Set property',
    category: 'model',
    doc: 'Writes one property on each entity; a null value deletes the property.',
    inputs: [
      { name: 'entity', type: ENTITY_ITEM },
      { name: 'value', type: SCALAR_ITEM, nullable: true },
    ],
    outputs: [{ name: 'entity', type: ENTITY_ITEM }],
    params: [
      { name: 'pset', kind: 'string', default: 'Pset_WallCommon' },
      { name: 'property', kind: 'string', default: 'FireRating' },
    ],
    capabilities: ['model.mutate:*'],
    writes: 'model',
    requires: { backend: ['mutate'] },
    run: (ctx, i, p) => {
      const pset = str(p.pset, 'pset');
      const prop = str(p.property, 'property');
      requireCapability(ctx, `model.mutate:${pset}`);
      const ref = toSdkRef(ctx, i.entity as EntityRef);
      const value = i.value as Scalar;
      if (value === null || value === undefined) ctx.host.bim.mutate.deleteProperty(ref, pset, prop);
      else ctx.host.bim.mutate.setProperty(ref, pset, prop, value);
      return { entity: i.entity };
    },
  },
  {
    type: 'model.setAttribute',
    title: 'Set attribute',
    category: 'model',
    doc: 'Writes a root attribute (Name, Description, ObjectType, Tag).',
    inputs: [
      { name: 'entity', type: ENTITY_ITEM },
      { name: 'value', type: SCALAR_ITEM },
    ],
    outputs: [{ name: 'entity', type: ENTITY_ITEM }],
    params: [{ name: 'attribute', kind: 'enum', default: 'Name', options: ['Name', 'Description', 'ObjectType', 'Tag'] }],
    capabilities: ['model.mutate:*'],
    writes: 'model',
    requires: { backend: ['mutate'] },
    run: (ctx, i, p) => {
      const attr = str(p.attribute, 'attribute');
      requireCapability(ctx, `model.mutate:attr.${attr}`);
      ctx.host.bim.mutate.setAttribute(toSdkRef(ctx, i.entity as EntityRef), attr, String(i.value));
      return { entity: i.entity };
    },
  },
];
