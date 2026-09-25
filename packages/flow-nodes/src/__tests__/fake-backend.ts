/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test fixture: a tiny in-memory `BimBackend` with two storeys, three walls
 * and three doors, real enough for the query/mutate/viewer paths the
 * standard nodes use. Everything else throws so a node reaching for an
 * unsupported namespace fails loudly in tests.
 */

import type { BimBackend, EntityData, EntityRef, PropertySetData, QueryDescriptor } from '@ifc-lite/sdk';
import { createBimContext, type BimContext } from '@ifc-lite/sdk';

export interface FakeEntity {
  readonly expressId: number;
  readonly globalId: string;
  readonly type: string;
  readonly name: string;
  readonly psets: Record<string, Record<string, string | number | boolean>>;
  /** Spatial container expressId. */
  readonly containedIn?: number;
  /** Openings voided by this element (IfcRelVoidsElement forward). */
  readonly voids?: readonly number[];
}

export const MODEL = 'm1';

export function fakeEntities(): FakeEntity[] {
  return [
    { expressId: 1, globalId: 'S1', type: 'IfcBuildingStorey', name: 'EG', psets: {} },
    { expressId: 2, globalId: 'S2', type: 'IfcBuildingStorey', name: 'OG', psets: {} },
    { expressId: 10, globalId: 'W1', type: 'IfcWall', name: 'Wall 1', psets: { Pset_WallCommon: { FireRating: 'REI60', IsExternal: true } }, containedIn: 1, voids: [20, 21] },
    { expressId: 11, globalId: 'W2', type: 'IfcWall', name: 'Wall 2', psets: { Pset_WallCommon: { IsExternal: false } }, containedIn: 1 },
    { expressId: 12, globalId: 'W3', type: 'IfcWall', name: 'Wall 3', psets: { Pset_WallCommon: { FireRating: 'REI90', IsExternal: true } }, containedIn: 2, voids: [22] },
    { expressId: 20, globalId: 'D1', type: 'IfcOpeningElement', name: 'Opening 1', psets: {}, containedIn: 1 },
    { expressId: 21, globalId: 'D2', type: 'IfcOpeningElement', name: 'Opening 2', psets: {}, containedIn: 1 },
    { expressId: 22, globalId: 'D3', type: 'IfcOpeningElement', name: 'Opening 3', psets: {}, containedIn: 2 },
  ];
}

export interface FakeHost {
  readonly bim: BimContext;
  readonly entities: FakeEntity[];
  readonly colorized: Array<{ refs: EntityRef[]; color: unknown }>;
  readonly mutations: Array<{ ref: EntityRef; pset?: string; prop: string; value: unknown }>;
  /** Every `bim.store.add*` call, in order: builder, storey expressId, params. */
  readonly created: Array<{ builder: string; storey: number; params: Record<string, unknown> }>;
  selection: EntityRef[];
}

const BUILDERS: Readonly<Record<string, string>> = {
  addWall: 'IfcWall', addSlab: 'IfcSlab', addRoof: 'IfcRoof', addColumn: 'IfcColumn', addBeam: 'IfcBeam',
};

const typeOf = (v: string | number | boolean): number => (typeof v === 'number' ? 1 : typeof v === 'boolean' ? 3 : 0);

export function createFakeBim(): FakeHost {
  const entities = fakeEntities();
  const colorized: FakeHost['colorized'] = [];
  const mutations: FakeHost['mutations'] = [];
  const created: FakeHost['created'] = [];
  let nextExpressId = 1000;
  // Store builders append a real entity (so query/entityData/properties see
  // it) and record the call; everything else on the store throws.
  const store: Record<string, unknown> = Object.fromEntries(
    Object.entries(BUILDERS).map(([builder, type]) => [
      builder,
      (modelId: string, storey: number, params: Record<string, unknown>): EntityRef => {
        const expressId = nextExpressId++;
        entities.push({ expressId, globalId: String(params.GlobalId ?? `N${expressId}`), type, name: String(params.Name ?? ''), psets: {}, containedIn: storey });
        created.push({ builder, storey, params });
        return { modelId, expressId };
      },
    ]),
  );
  store.removeEntity = (ref: EntityRef): boolean => {
    const i = entities.findIndex((e) => e.expressId === ref.expressId);
    if (i < 0) return false;
    entities.splice(i, 1);
    return true;
  };
  const state = { selection: [] as EntityRef[] };
  const byId = (expressId: number) => entities.find((e) => e.expressId === expressId);
  const data = (e: FakeEntity): EntityData => ({ ref: { modelId: MODEL, expressId: e.expressId }, globalId: e.globalId, name: e.name, type: e.type, description: '', objectType: '' });
  const psets = (e: FakeEntity): PropertySetData[] =>
    Object.entries(e.psets).map(([name, props]) => ({ name, properties: Object.entries(props).map(([n, v]) => ({ name: n, type: typeOf(v), value: v })) }));

  const backend: Partial<BimBackend> = {
    model: {
      list: () => [{ id: MODEL, name: 'fake.ifc', schema: 'IFC4', schemaVersion: 'IFC4', entityCount: entities.length, fileSize: 0, loadedAt: 0 }],
      activeId: () => MODEL,
      loadIfc: () => undefined,
    },
    query: {
      entities: (d: QueryDescriptor) =>
        entities
          .filter((e) => !d.types || d.types.length === 0 || d.types.includes(e.type))
          .filter((e) =>
            (d.filters ?? []).every((f) => {
              const v = e.psets[f.psetName]?.[f.propName];
              if (f.operator === '=') return v === f.value;
              if (f.operator === '!=') return v !== f.value;
              return false;
            }),
          )
          .map(data),
      entitiesMatchingActiveFilter: () => null,
      entityData: (ref) => (ref.modelId === MODEL && byId(ref.expressId) ? data(byId(ref.expressId)!) : null),
      attributes: () => [],
      properties: (ref) => (byId(ref.expressId) ? psets(byId(ref.expressId)!) : []),
      quantities: () => [],
      classifications: () => [],
      materials: () => null,
      typeProperties: () => null,
      documents: () => [],
      relationships: () => ({ voids: [], fills: [], groups: [], connections: [] }),
      related: (ref, relType, direction) => {
        const e = byId(ref.expressId);
        if (!e) return [];
        if (relType === 'IfcRelVoidsElement' && direction === 'forward') return (e.voids ?? []).map((id) => ({ modelId: MODEL, expressId: id }));
        if (relType === 'IfcRelContainedInSpatialStructure' && direction === 'inverse') return e.containedIn ? [{ modelId: MODEL, expressId: e.containedIn }] : [];
        if (relType === 'IfcRelContainedInSpatialStructure' && direction === 'forward') return entities.filter((x) => x.containedIn === e.expressId).map((x) => ({ modelId: MODEL, expressId: x.expressId }));
        return [];
      },
    },
    selection: { get: () => state.selection, set: (refs) => { state.selection = refs; } },
    visibility: { hide: () => undefined, show: () => undefined, isolate: () => undefined, reset: () => undefined },
    viewer: {
      colorize: (refs, color) => { colorized.push({ refs, color }); },
      colorizeAll: () => undefined,
      resetColors: () => undefined,
      flyTo: () => undefined,
      setSection: () => undefined,
      getSection: () => null,
      setCamera: () => undefined,
      getCamera: () => ({ mode: 'perspective' }),
    },
    mutate: {
      setProperty: (ref, pset, prop, value) => {
        mutations.push({ ref, pset, prop, value });
        const e = byId(ref.expressId);
        if (e) (e.psets[pset] ??= {})[prop] = value;
      },
      setAttribute: (ref, prop, value) => { mutations.push({ ref, prop, value }); },
      deleteProperty: (ref, pset, prop) => {
        mutations.push({ ref, pset, prop, value: null });
        const e = byId(ref.expressId);
        if (e?.psets[pset]) delete e.psets[pset][prop];
      },
      batchBegin: () => undefined,
      batchEnd: () => undefined,
      undo: () => false,
      redo: () => false,
    },
    store: store as unknown as BimBackend['store'],
    subscribe: () => () => undefined,
  };
  const bim = createBimContext({ backend: backend as BimBackend });
  return {
    bim,
    entities,
    colorized,
    mutations,
    created,
    get selection() { return state.selection; },
    set selection(refs: EntityRef[]) { state.selection = refs; },
  };
}
