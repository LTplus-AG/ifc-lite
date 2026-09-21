/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `viewer.*` — viewport feedback. Every node here requires the `viewer`
 * backend feature and is a no-op headlessly (`headless: 'noop'`), so a CI
 * run of a graph that colorizes failures still validates and runs; the
 * node passes its `entities` through so the graph chains the same way.
 */

import type { EntityRef } from '@ifc-lite/flow';
import { ENTITY_LIST, requireCapability, toSdkRef, type Ctx, type FlowNodeDef } from './host.js';

const refs = (ctx: Ctx, entities: unknown) => (entities as EntityRef[]).map((e) => toSdkRef(ctx, e));

export const viewerNodes: FlowNodeDef[] = [
  {
    type: 'viewer.colorize',
    title: 'Colorize',
    category: 'viewer',
    inputs: [{ name: 'entities', type: ENTITY_LIST }],
    outputs: [{ name: 'entities', type: ENTITY_LIST }],
    params: [{ name: 'color', kind: 'string', default: '#ff0000' }],
    capabilities: ['viewer.colorize'],
    requires: { backend: ['viewer'] },
    headless: 'noop',
    run: (ctx, i, p) => {
      requireCapability(ctx, 'viewer.colorize');
      ctx.host.bim.viewer.colorize(refs(ctx, i.entities), String(p.color));
      return { entities: i.entities };
    },
  },
  {
    type: 'viewer.isolate',
    title: 'Isolate',
    category: 'viewer',
    inputs: [{ name: 'entities', type: ENTITY_LIST }],
    outputs: [{ name: 'entities', type: ENTITY_LIST }],
    params: [],
    capabilities: ['viewer.isolate'],
    requires: { backend: ['visibility'] },
    headless: 'noop',
    run: (ctx, i) => {
      requireCapability(ctx, 'viewer.isolate');
      ctx.host.bim.viewer.isolate(refs(ctx, i.entities));
      return { entities: i.entities };
    },
  },
  {
    type: 'viewer.select',
    title: 'Select in viewer',
    category: 'viewer',
    inputs: [{ name: 'entities', type: ENTITY_LIST }],
    outputs: [{ name: 'entities', type: ENTITY_LIST }],
    params: [],
    capabilities: ['viewer.read'],
    requires: { backend: ['selection'] },
    headless: 'noop',
    run: (ctx, i) => {
      requireCapability(ctx, 'viewer.read');
      ctx.host.bim.viewer.select(refs(ctx, i.entities));
      return { entities: i.entities };
    },
  },
  {
    type: 'viewer.selection',
    title: 'Current selection',
    category: 'viewer',
    inputs: [],
    outputs: [{ name: 'entities', type: ENTITY_LIST }],
    params: [],
    capabilities: ['viewer.read'],
    requires: { backend: ['selection'] },
    headless: 'noop',
    run: (ctx) => {
      requireCapability(ctx, 'viewer.read');
      const entities: EntityRef[] = [];
      for (const ref of ctx.host.bim.viewer.getSelection()) {
        const e = ctx.host.bim.entity(ref);
        if (e) entities.push({ globalId: e.globalId, modelId: ref.modelId, expressId: ref.expressId });
      }
      return { entities };
    },
  },
  {
    type: 'viewer.flyTo',
    title: 'Fly to',
    category: 'viewer',
    inputs: [{ name: 'entities', type: ENTITY_LIST }],
    outputs: [{ name: 'entities', type: ENTITY_LIST }],
    params: [],
    capabilities: ['viewer.fly'],
    requires: { backend: ['viewer'] },
    headless: 'noop',
    run: (ctx, i) => {
      requireCapability(ctx, 'viewer.fly');
      ctx.host.bim.viewer.flyTo(refs(ctx, i.entities));
      return { entities: i.entities };
    },
  },
];
