/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `geometry.*` and `element.*` — parametric element specs, and the one
 * tracked node that materialises them: `model.addElement`.
 *
 * A spec is a value (`ElementSpec`), so building geometry and writing it
 * are separate steps: specs can be inspected, tabulated, or filtered before
 * anything touches the model. `model.addElement` is `tracked`: the
 * scheduler hands it create / update / keep per lane with a GlobalId
 * derived from the node's tracking key, and calls `remove` for lanes that
 * vanished — so a re-run updates elements instead of duplicating them.
 *
 * Geometry is parametric only (what `bim.store.add*` can author): there
 * is no BRep / Solid write path, and this file does not pretend otherwise.
 */

import type { EntityRef, Point } from '@ifc-lite/flow';
import type { AddBeamInStoreParams, AddColumnInStoreParams, AddSlabRectangleParams, AddWallInStoreParams, EntityRef as SdkEntityRef } from '@ifc-lite/sdk';
import { ENTITY_ITEM, SCALAR_ITEM, forgetGlobalId, rememberGlobalId, requireCapability, resolveByGlobalId, toSdkRef, type Ctx, type FlowNodeDef } from './host.js';

export type ElementSpec =
  | { readonly kind: 'wall'; readonly storey: EntityRef; readonly params: AddWallInStoreParams }
  | { readonly kind: 'column'; readonly storey: EntityRef; readonly params: AddColumnInStoreParams }
  | { readonly kind: 'beam'; readonly storey: EntityRef; readonly params: AddBeamInStoreParams }
  | { readonly kind: 'slab'; readonly storey: EntityRef; readonly params: AddSlabRectangleParams };

const POINT_ITEM = { kind: 'point', access: 'item' } as const;
const SPEC_ITEM = { kind: 'elementSpec', access: 'item' } as const;

const num = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${name}" must be a finite number`);
  return v;
};
/** A fresh mutable triple: the SDK params are mutable tuples, flow points are readonly. */
const point = (v: unknown, name: string): [number, number, number] => {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error(`"${name}" must be a point [x, y, z]`);
  return [v[0], v[1], v[2]];
};
const optName = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function specOf(v: unknown): ElementSpec {
  const s = v as Partial<ElementSpec>;
  if (!s || typeof s !== 'object' || !s.kind || !s.storey || !s.params) throw new Error('"spec" must be an element spec from an element.* node');
  return s as ElementSpec;
}

export const elementNodes: FlowNodeDef[] = [
  {
    type: 'geometry.point',
    title: 'Point',
    category: 'geometry',
    inputs: [
      { name: 'x', type: SCALAR_ITEM },
      { name: 'y', type: SCALAR_ITEM },
      { name: 'z', type: SCALAR_ITEM, optional: true, nullable: true },
    ],
    outputs: [{ name: 'point', type: POINT_ITEM }],
    params: [],
    capabilities: [],
    run: (_c, i) => ({ point: [num(i.x, 'x'), num(i.y, 'y'), i.z === undefined || i.z === null ? 0 : num(i.z, 'z')] as Point }),
  },
  {
    type: 'element.wall',
    title: 'Wall spec',
    category: 'element',
    inputs: [
      { name: 'storey', type: ENTITY_ITEM },
      { name: 'start', type: POINT_ITEM },
      { name: 'end', type: POINT_ITEM },
    ],
    outputs: [{ name: 'spec', type: SPEC_ITEM }],
    params: [
      { name: 'thickness', kind: 'number', default: 0.2 },
      { name: 'height', kind: 'number', default: 3 },
      { name: 'name', kind: 'string' },
    ],
    capabilities: [],
    run: (_c, i, p) => ({
      spec: {
        kind: 'wall',
        storey: i.storey as EntityRef,
        params: { Start: point(i.start, 'start'), End: point(i.end, 'end'), Thickness: num(p.thickness, 'thickness'), Height: num(p.height, 'height'), Name: optName(p.name) },
      } satisfies ElementSpec,
    }),
  },
  {
    type: 'element.column',
    title: 'Column spec',
    category: 'element',
    inputs: [
      { name: 'storey', type: ENTITY_ITEM },
      { name: 'position', type: POINT_ITEM },
    ],
    outputs: [{ name: 'spec', type: SPEC_ITEM }],
    params: [
      { name: 'width', kind: 'number', default: 0.3 },
      { name: 'depth', kind: 'number', default: 0.3 },
      { name: 'height', kind: 'number', default: 3 },
      { name: 'name', kind: 'string' },
    ],
    capabilities: [],
    run: (_c, i, p) => ({
      spec: {
        kind: 'column',
        storey: i.storey as EntityRef,
        params: { Position: point(i.position, 'position'), Width: num(p.width, 'width'), Depth: num(p.depth, 'depth'), Height: num(p.height, 'height'), Name: optName(p.name) },
      } satisfies ElementSpec,
    }),
  },
  {
    type: 'element.beam',
    title: 'Beam spec',
    category: 'element',
    inputs: [
      { name: 'storey', type: ENTITY_ITEM },
      { name: 'start', type: POINT_ITEM },
      { name: 'end', type: POINT_ITEM },
    ],
    outputs: [{ name: 'spec', type: SPEC_ITEM }],
    params: [
      { name: 'width', kind: 'number', default: 0.2 },
      { name: 'height', kind: 'number', default: 0.4 },
      { name: 'name', kind: 'string' },
    ],
    capabilities: [],
    run: (_c, i, p) => ({
      spec: {
        kind: 'beam',
        storey: i.storey as EntityRef,
        params: { Start: point(i.start, 'start'), End: point(i.end, 'end'), Width: num(p.width, 'width'), Height: num(p.height, 'height'), Name: optName(p.name) },
      } satisfies ElementSpec,
    }),
  },
  {
    type: 'element.slab',
    title: 'Slab spec',
    category: 'element',
    inputs: [
      { name: 'storey', type: ENTITY_ITEM },
      { name: 'position', type: POINT_ITEM },
    ],
    outputs: [{ name: 'spec', type: SPEC_ITEM }],
    params: [
      { name: 'width', kind: 'number', default: 5 },
      { name: 'depth', kind: 'number', default: 5 },
      { name: 'thickness', kind: 'number', default: 0.25 },
      { name: 'name', kind: 'string' },
    ],
    capabilities: [],
    run: (_c, i, p) => ({
      spec: {
        kind: 'slab',
        storey: i.storey as EntityRef,
        params: { Profile: 'rectangle', Position: point(i.position, 'position'), Width: num(p.width, 'width'), Depth: num(p.depth, 'depth'), Thickness: num(p.thickness, 'thickness'), Name: optName(p.name) },
      } satisfies ElementSpec,
    }),
  },
  {
    type: 'model.addElement',
    title: 'Add element',
    category: 'model',
    doc: 'Materialises a spec in the model. Tracked: a re-run updates the element it made instead of adding another.',
    inputs: [{ name: 'spec', type: SPEC_ITEM }],
    outputs: [{ name: 'entity', type: ENTITY_ITEM }],
    params: [],
    capabilities: ['model.create'],
    writes: 'model',
    tracked: true,
    requires: { backend: ['store'] },
    run: (ctx, i) => {
      requireCapability(ctx, 'model.create');
      const spec = specOf(i.spec);
      const t = ctx.tracking;
      if (!t) throw new Error('model.addElement must run as a tracked node');
      const storey = toSdkRef(ctx, spec.storey);
      const existing = resolveByGlobalId(ctx.host.bim, t.globalId);
      ctx.log('info', `${t.action} ${spec.kind} ${t.globalId}${existing ? ` (#${existing.expressId})` : ''}`);
      if (t.action === 'keep' && existing) {
        return { entity: { globalId: t.globalId, modelId: existing.modelId, expressId: existing.expressId } satisfies EntityRef };
      }
      if (t.action === 'create' && existing) {
        throw new Error(`GlobalId ${t.globalId} already exists in the model; change the node's tracking key rather than overwrite a foreign element`);
      }
      // `update` and a `keep` whose element is gone (deleted by hand, or the
      // model was rebuilt from an older file) both end in a fresh element under
      // the same GlobalId; a keep that returned a handle to nothing would read
      // as success downstream.
      if (t.action === 'update' && existing) {
        ctx.host.bim.store.removeEntity(existing);
        forgetGlobalId(ctx.host.bim, t.globalId);
      } else if (t.action !== 'create') {
        ctx.log('warn', `element ${t.globalId} was tracked but is no longer in the model; re-creating it`);
      }
      const ref = addSpec(ctx, storey, spec, t.globalId);
      rememberGlobalId(ctx.host.bim, t.globalId, ref);
      return { entity: { globalId: t.globalId, modelId: ref.modelId, expressId: ref.expressId } satisfies EntityRef };
    },
    remove: (ctx, globalId) => {
      const existing = resolveByGlobalId(ctx.host.bim, globalId);
      if (existing) {
        ctx.host.bim.store.removeEntity(existing);
        forgetGlobalId(ctx.host.bim, globalId);
      } else ctx.log('warn', `tracked element ${globalId} was already gone`);
    },
  },
  {
    type: 'model.delete',
    title: 'Delete element',
    category: 'model',
    inputs: [{ name: 'entity', type: ENTITY_ITEM }],
    outputs: [{ name: 'removed', type: SCALAR_ITEM }],
    params: [],
    capabilities: ['model.delete'],
    writes: 'model',
    requires: { backend: ['store'] },
    run: (ctx, i) => {
      requireCapability(ctx, 'model.delete');
      const entity = i.entity as EntityRef;
      const removed = ctx.host.bim.store.removeEntity(toSdkRef(ctx, entity));
      // The index would otherwise keep resolving the tombstoned address, and a
      // later tracked create under that GlobalId would see a "foreign" element.
      if (removed) forgetGlobalId(ctx.host.bim, entity.globalId);
      return { removed };
    },
  },
];

function addSpec(ctx: Ctx, storey: SdkEntityRef, spec: ElementSpec, GlobalId: string): SdkEntityRef {
  const store = ctx.host.bim.store;
  switch (spec.kind) {
    case 'wall': return store.addWall(storey.modelId, storey.expressId, { ...spec.params, GlobalId });
    case 'column': return store.addColumn(storey.modelId, storey.expressId, { ...spec.params, GlobalId });
    case 'beam': return store.addBeam(storey.modelId, storey.expressId, { ...spec.params, GlobalId });
    case 'slab': return store.addSlab(storey.modelId, storey.expressId, { ...spec.params, GlobalId });
    default: throw new Error(`unknown element kind "${String((spec as { kind: unknown }).kind)}"`);
  }
}
