/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Namespace-level coverage for the `bim.*` surfaces `context.test.ts`
 * does not reach.
 *
 * `ModelNamespace`, `EventsNamespace`, `ScheduleNamespace` and
 * `SpacesNamespace` are all exported from the package root and wired
 * into `BimContext`, so external consumers call them — but each had
 * only three repo-wide occurrences (definition, context wiring, barrel
 * re-export) and no test. Mutation testing confirmed it: dropping
 * `ModelNamespace.active()`'s null guard, dropping the unsubscribe
 * bookkeeping in `EventsNamespace`, routing `schedule.tasks()` at
 * `schedule.sequences()`, and disabling the "no spaces backend" guard
 * all left the SDK suite green.
 *
 * The `QueryBuilder` / `QueryNamespace` cases below are the ones the
 * existing chain tests miss: descriptor restoration after `first()`,
 * the default comparison operator, first-vs-last relationship pick, and
 * the 3-arg qset-name filter in `quantity()`.
 */

import { describe, expect, it, vi } from 'vitest';
import { ModelNamespace } from './model.js';
import { EventsNamespace } from './events.js';
import { ScheduleNamespace } from './schedule.js';
import { SpacesNamespace } from './spaces.js';
import { QueryNamespace } from './query.js';
import type {
  BimBackend,
  EntityData,
  EntityRef,
  ModelInfo,
  QuantitySetData,
  QueryDescriptor,
} from '../types.js';

function modelInfo(id: string): ModelInfo {
  return {
    id,
    name: `${id}.ifc`,
    schema: 'IFC4',
    schemaVersion: 'IFC4',
    entityCount: 1,
    fileSize: 1,
    loadedAt: 0,
  };
}

// ---------------------------------------------------------------------------
// ModelNamespace
// ---------------------------------------------------------------------------

describe('ModelNamespace', () => {
  function setup(activeId: string | null, models: ModelInfo[]) {
    const model = {
      list: vi.fn(() => models),
      activeId: vi.fn(() => activeId),
      loadIfc: vi.fn(),
    };
    return { ns: new ModelNamespace({ model } as unknown as BimBackend), model };
  }

  it('list() passes the backend list straight through', () => {
    const models = [modelInfo('arch')];
    const { ns } = setup('arch', models);
    expect(ns.list()).toBe(models);
  });

  it('active() resolves the active model', () => {
    const { ns } = setup('arch', [modelInfo('mep'), modelInfo('arch')]);
    expect(ns.active()?.id).toBe('arch');
  });

  // Without the `if (!id) return null` guard, `list().find(m => m.id === null)`
  // returns undefined → `?? null`, so the *return value* is the same. The
  // observable difference is that the backend list is queried at all — and,
  // more importantly, that a model whose id is the empty string would match.
  it('active() returns null when no model is active, without consulting the list', () => {
    const { ns, model } = setup(null, [modelInfo('arch')]);
    expect(ns.active()).toBeNull();
    expect(model.list).not.toHaveBeenCalled();
  });

  it('active() returns null for an active id that is not in the list', () => {
    const { ns } = setup('ghost', [modelInfo('arch')]);
    expect(ns.active()).toBeNull();
  });

  it('get() returns the matching model or null', () => {
    const { ns } = setup('arch', [modelInfo('arch'), modelInfo('mep')]);
    expect(ns.get('mep')?.id).toBe('mep');
    expect(ns.get('nope')).toBeNull();
  });

  it('loadIfc() defaults the filename to created.ifc', () => {
    const { ns, model } = setup('arch', []);
    ns.loadIfc('ISO-10303-21;');
    expect(model.loadIfc).toHaveBeenCalledWith('ISO-10303-21;', 'created.ifc');
  });

  it('loadIfc() forwards an explicit filename', () => {
    const { ns, model } = setup('arch', []);
    ns.loadIfc('ISO-10303-21;', 'tower.ifc');
    expect(model.loadIfc).toHaveBeenCalledWith('ISO-10303-21;', 'tower.ifc');
  });
});

// ---------------------------------------------------------------------------
// EventsNamespace
// ---------------------------------------------------------------------------

describe('EventsNamespace', () => {
  function setup() {
    const unsubs: Array<() => void> = [];
    const subscribe = vi.fn((_event: string, _handler: (d: unknown) => void) => {
      const unsub = vi.fn();
      unsubs.push(unsub);
      return unsub;
    });
    return { ns: new EventsNamespace({ subscribe } as unknown as BimBackend), subscribe, unsubs };
  }

  it('on() subscribes on the backend and hands back the unsubscribe', () => {
    const { ns, subscribe, unsubs } = setup();
    const handler = vi.fn();

    const off = ns.on('selection:changed', handler);
    expect(subscribe).toHaveBeenCalledWith('selection:changed', handler);

    off();
    expect(unsubs[0]).toHaveBeenCalledTimes(1);
  });

  it('removeAll() calls every outstanding unsubscribe', () => {
    const { ns, unsubs } = setup();
    ns.on('selection:changed', vi.fn());
    ns.on('model:loaded', vi.fn());

    ns.removeAll();

    expect(unsubs).toHaveLength(2);
    for (const u of unsubs) expect(u).toHaveBeenCalledTimes(1);
  });

  // The per-subscription `unsubscribers.delete(id)` is the bookkeeping
  // that stops `removeAll()` from calling an already-released
  // unsubscribe a second time. Without it the backend sees a double
  // unsubscribe for every handler the caller released itself.
  it('does not re-run an unsubscribe that the caller already invoked', () => {
    const { ns, unsubs } = setup();
    const off = ns.on('selection:changed', vi.fn());
    ns.on('model:loaded', vi.fn());

    off();
    ns.removeAll();

    expect(unsubs[0]).toHaveBeenCalledTimes(1);
    expect(unsubs[1]).toHaveBeenCalledTimes(1);
  });

  it('removeAll() is idempotent', () => {
    const { ns, unsubs } = setup();
    ns.on('selection:changed', vi.fn());

    ns.removeAll();
    ns.removeAll();

    expect(unsubs[0]).toHaveBeenCalledTimes(1);
  });

  // The bookkeeping key is `${event}-${nextId++}`, and the counter is
  // the whole point: two subscriptions to the *same* event must occupy
  // two map slots. The `offA()` half of this test does not reach that —
  // each unsubscribe closes over its own `unsub`, so it holds with a
  // constant key too. The `removeAll()` half is what discriminates:
  // with a per-event key the second `on()` overwrites the first slot,
  // `offA()` deletes that single slot, and B's unsubscribe is never
  // called — a listener leaked past `removeAll()`.
  it('gives each subscription its own unsubscribe, even for the same event', () => {
    const { ns, unsubs } = setup();
    const offA = ns.on('selection:changed', vi.fn());
    ns.on('selection:changed', vi.fn());

    offA();
    expect(unsubs[0]).toHaveBeenCalledTimes(1);
    expect(unsubs[1]).not.toHaveBeenCalled();

    ns.removeAll();
    expect(unsubs[0]).toHaveBeenCalledTimes(1); // not re-run
    expect(unsubs[1]).toHaveBeenCalledTimes(1); // released, not leaked
  });

  it('removeAll() releases every subscription to one and the same event', () => {
    const { ns, unsubs } = setup();
    ns.on('selection:changed', vi.fn());
    ns.on('selection:changed', vi.fn());
    ns.on('selection:changed', vi.fn());

    ns.removeAll();

    expect(unsubs).toHaveLength(3);
    for (const u of unsubs) expect(u).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ScheduleNamespace
// ---------------------------------------------------------------------------

describe('ScheduleNamespace', () => {
  function setup() {
    const schedule = {
      data: vi.fn(() => ({ kind: 'data' })),
      tasks: vi.fn(() => [{ kind: 'task' }]),
      workSchedules: vi.fn(() => [{ kind: 'workSchedule' }]),
      sequences: vi.fn(() => [{ kind: 'sequence' }]),
    };
    return { ns: new ScheduleNamespace({ schedule } as unknown as BimBackend), schedule };
  }

  // Each accessor must reach its *own* backend method — the four have
  // identical signatures, so a mis-wired one is invisible without a
  // per-method assertion.
  it('routes each accessor to the matching backend method', () => {
    const { ns, schedule } = setup();

    expect(ns.data('arch')).toEqual({ kind: 'data' });
    expect(ns.tasks('arch')).toEqual([{ kind: 'task' }]);
    expect(ns.workSchedules('arch')).toEqual([{ kind: 'workSchedule' }]);
    expect(ns.sequences('arch')).toEqual([{ kind: 'sequence' }]);

    expect(schedule.data).toHaveBeenCalledWith('arch');
    expect(schedule.tasks).toHaveBeenCalledWith('arch');
    expect(schedule.workSchedules).toHaveBeenCalledWith('arch');
    expect(schedule.sequences).toHaveBeenCalledWith('arch');
  });

  it('forwards an omitted modelId as undefined so the backend picks the active model', () => {
    const { ns, schedule } = setup();
    ns.tasks();
    expect(schedule.tasks).toHaveBeenCalledWith(undefined);
  });
});

// ---------------------------------------------------------------------------
// SpacesNamespace
// ---------------------------------------------------------------------------

describe('SpacesNamespace', () => {
  it('delegates to the backend when space derivation is available', () => {
    const spaces = {
      listStoreys: vi.fn(() => [{ expressId: 1, name: 'EG', elevation: 0 }]),
      generate: vi.fn(() => ({ created: 3 })),
    };
    const ns = new SpacesNamespace({ spaces } as unknown as BimBackend);

    expect(ns.storeys()).toEqual([{ expressId: 1, name: 'EG', elevation: 0 }]);
    ns.generate({ height: 'auto' } as never);
    expect(spaces.generate).toHaveBeenCalledWith({ height: 'auto' });
  });

  // `backend.spaces` is optional: remote/transport-backed contexts leave
  // it undefined because the store lives server-side. Without the guard
  // the caller gets an opaque "cannot read properties of undefined"
  // instead of the actionable message.
  it('throws an explanatory error when the backend has no spaces support', () => {
    const ns = new SpacesNamespace({} as unknown as BimBackend);

    expect(() => ns.storeys()).toThrow(/spaces: not available on this backend/);
    expect(() => ns.generate()).toThrow(/spaces: not available on this backend/);
  });

  it('names the remedy in the error so a script author can act on it', () => {
    const ns = new SpacesNamespace({} as unknown as BimBackend);
    expect(() => ns.storeys()).toThrow(/headless\/local context/);
  });
});

// ---------------------------------------------------------------------------
// QueryBuilder / QueryNamespace
// ---------------------------------------------------------------------------

function entity(modelId: string, expressId: number, type = 'IfcWall'): EntityData {
  return {
    ref: { modelId, expressId },
    globalId: `g${expressId}`,
    name: `e${expressId}`,
    type,
    description: '',
    objectType: '',
  };
}

describe('QueryBuilder', () => {
  function setup(results: EntityData[]) {
    const seen: QueryDescriptor[] = [];
    const entities = vi.fn((d: QueryDescriptor) => {
      seen.push(structuredClone(d));
      return results;
    });
    const backend = { query: { entities } } as unknown as BimBackend;
    return { ns: new QueryNamespace(backend), seen };
  }

  it('defaults the comparison operator to "exists" when none is given', () => {
    const { ns, seen } = setup([]);
    ns.create().where('Pset_WallCommon', 'IsExternal').toArray();
    expect(seen[0].filters).toEqual([
      { psetName: 'Pset_WallCommon', propName: 'IsExternal', operator: 'exists', value: undefined },
    ]);
  });

  it('keeps an explicit operator and value', () => {
    const { ns, seen } = setup([]);
    ns.create().where('Pset_WallCommon', 'IsExternal', '=', true).toArray();
    expect(seen[0].filters?.[0].operator).toBe('=');
    expect(seen[0].filters?.[0].value).toBe(true);
  });

  it('accumulates types and filters across chained calls', () => {
    const { ns, seen } = setup([]);
    ns.create().byType('IfcWall').byType('IfcSlab', 'IfcRoof').model('arch').limit(5).offset(2).toArray();
    expect(seen[0]).toEqual({
      types: ['IfcWall', 'IfcSlab', 'IfcRoof'],
      modelId: 'arch',
      limit: 5,
      offset: 2,
    });
  });

  // `first()` sets limit=1 for one call and must put the caller's limit
  // back. Without the restore, a builder reused after `first()` silently
  // returns one row.
  it('first() restores the caller-supplied limit afterwards', () => {
    const { ns, seen } = setup([entity('arch', 1), entity('arch', 2)]);
    const builder = ns.create().limit(10);

    expect(builder.first()?.ref.expressId).toBe(1);
    builder.toArray();

    expect(seen[0].limit).toBe(1);
    expect(seen[1].limit).toBe(10);
  });

  it('first() restores an absent limit as absent, not as 1', () => {
    const { ns, seen } = setup([entity('arch', 1)]);
    const builder = ns.create();

    builder.first();
    builder.toArray();

    expect(seen[0].limit).toBe(1);
    expect(seen[1].limit).toBeUndefined();
  });

  it('first() returns null on an empty result', () => {
    const { ns } = setup([]);
    expect(ns.create().first()).toBeNull();
  });

  it('count() and refs() read the same descriptor', () => {
    const { ns } = setup([entity('arch', 1), entity('arch', 2)]);
    expect(ns.create().count()).toBe(2);
    expect(ns.create().refs()).toEqual([
      { modelId: 'arch', expressId: 1 },
      { modelId: 'arch', expressId: 2 },
    ]);
  });
});

describe('QueryNamespace — relationship navigation', () => {
  function setup(related: EntityRef[], data: Record<number, EntityData>) {
    const backend = {
      query: {
        related: vi.fn(() => related),
        entityData: vi.fn((r: EntityRef) => data[r.expressId] ?? null),
      },
    } as unknown as BimBackend;
    return new QueryNamespace(backend);
  }

  // Both `containedIn` and `decomposedBy` document "the" parent, and the
  // backend returns them in relationship order. Picking any element other
  // than the first would change which storey a script reports.
  it('containedIn() resolves the first related ref, not the last', () => {
    const ns = setup(
      [{ modelId: 'arch', expressId: 10 }, { modelId: 'arch', expressId: 20 }],
      { 10: entity('arch', 10, 'IfcBuildingStorey'), 20: entity('arch', 20, 'IfcBuilding') },
    );
    expect(ns.containedIn({ modelId: 'arch', expressId: 1 })?.ref.expressId).toBe(10);
  });

  it('decomposedBy() resolves the first related ref, not the last', () => {
    const ns = setup(
      [{ modelId: 'arch', expressId: 10 }, { modelId: 'arch', expressId: 20 }],
      { 10: entity('arch', 10, 'IfcBuilding'), 20: entity('arch', 20, 'IfcSite') },
    );
    expect(ns.decomposedBy({ modelId: 'arch', expressId: 1 })?.ref.expressId).toBe(10);
  });

  it('containedIn() and decomposedBy() return null with no relations', () => {
    const ns = setup([], {});
    expect(ns.containedIn({ modelId: 'arch', expressId: 1 })).toBeNull();
    expect(ns.decomposedBy({ modelId: 'arch', expressId: 1 })).toBeNull();
  });

  it('related() drops refs the backend cannot resolve', () => {
    const ns = setup(
      [{ modelId: 'arch', expressId: 10 }, { modelId: 'arch', expressId: 99 }],
      { 10: entity('arch', 10) },
    );
    const out = ns.related({ modelId: 'arch', expressId: 1 }, 'IfcRelAggregates', 'forward');
    expect(out.map((e) => e.ref.expressId)).toEqual([10]);
  });
});

describe('QueryNamespace — quantity()', () => {
  function setup(qsets: QuantitySetData[]) {
    const backend = {
      query: { quantities: vi.fn(() => qsets) },
    } as unknown as BimBackend;
    return new QueryNamespace(backend);
  }

  const REF: EntityRef = { modelId: 'arch', expressId: 1 };

  const QSETS: QuantitySetData[] = [
    { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetVolume', type: 0, value: 1 }] },
    { name: 'Custom_Quantities', quantities: [{ name: 'NetVolume', type: 0, value: 99 }] },
  ];

  // The 3-arg form exists specifically to scope the lookup to a qset.
  // Without the `matchSet` filter it degenerates into the 2-arg form and
  // returns whichever set happens to come first.
  it('3-arg form honours the qset name', () => {
    const ns = setup(QSETS);
    expect(ns.quantity(REF, 'Custom_Quantities', 'NetVolume')).toBe(99);
    expect(ns.quantity(REF, 'Qto_WallBaseQuantities', 'NetVolume')).toBe(1);
  });

  it('3-arg form returns null when no qset name matches', () => {
    const ns = setup(QSETS);
    expect(ns.quantity(REF, 'Qto_SlabBaseQuantities', 'NetVolume')).toBeNull();
  });

  it('3-arg form accepts a /regex/ qset pattern', () => {
    const ns = setup(QSETS);
    expect(ns.quantity(REF, '/Qto_.*BaseQuantities/', 'NetVolume')).toBe(1);
  });

  it('2-arg form searches every qset and returns the first match', () => {
    const ns = setup(QSETS);
    expect(ns.quantity(REF, 'NetVolume')).toBe(1);
  });

  it('returns null for an unknown quantity name', () => {
    const ns = setup(QSETS);
    expect(ns.quantity(REF, 'GrossVolume')).toBeNull();
  });
});
