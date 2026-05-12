/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  generateScheduleFromSpatialHierarchy,
  canGenerateScheduleFrom,
  DEFAULT_OPTIONS,
  toLocalIso,
} from './generate-schedule.js';

/**
 * Build a minimal mock IfcDataStore whose spatialHierarchy fixture has three
 * storeys with 3 / 2 / 1 contained elements respectively. Elevations are set
 * so bottom-up ordering is deterministic.
 */
function buildMockStore(): IfcDataStore {
  const entitiesByExpressId = new Map<number, { name: string; globalId: string }>([
    [100, { name: 'Ground', globalId: 'storey-0000' }],
    [101, { name: 'Level 1', globalId: 'storey-1111' }],
    [102, { name: 'Roof', globalId: 'storey-2222' }],
    [1, { name: 'Wall A', globalId: 'wall-A' }],
    [2, { name: 'Wall B', globalId: 'wall-B' }],
    [3, { name: 'Slab G', globalId: 'slab-G' }],
    [4, { name: 'Column 1', globalId: 'col-1' }],
    [5, { name: 'Window', globalId: 'win-1' }],
    [6, { name: 'Roof Slab', globalId: 'slab-R' }],
  ]);

  return {
    spatialHierarchy: {
      project: { expressId: 0, type: 0, name: 'Project', children: [], elements: [] },
      byStorey: new Map([
        [100, [1, 2, 3]],
        [101, [4, 5]],
        [102, [6]],
      ]),
      byBuilding: new Map([[99, [1, 2, 3, 4, 5, 6]]]),
      bySite: new Map(),
      bySpace: new Map(),
      storeyElevations: new Map([[100, 0], [101, 3], [102, 6.5]]),
      storeyHeights: new Map(),
      elementToStorey: new Map(),
      getStoreyElements: () => [],
      getStoreyByElevation: () => null,
      getContainingSpace: () => null,
      getPath: () => [],
    },
    entities: {
      getName: (id: number) => entitiesByExpressId.get(id)?.name ?? '',
      getGlobalId: (id: number) => entitiesByExpressId.get(id)?.globalId ?? '',
    },
  } as unknown as IfcDataStore;
}

describe('canGenerateScheduleFrom', () => {
  it('returns false for null/missing hierarchy', () => {
    assert.strictEqual(canGenerateScheduleFrom(null), false);
    assert.strictEqual(canGenerateScheduleFrom(undefined), false);
    assert.strictEqual(
      canGenerateScheduleFrom({ spatialHierarchy: undefined } as unknown as IfcDataStore),
      false,
    );
  });

  it('returns true when storeys or buildings exist', () => {
    assert.strictEqual(canGenerateScheduleFrom(buildMockStore()), true);
  });
});

describe('generateScheduleFromSpatialHierarchy — storey strategy', () => {
  it('produces one task per storey, bottom-up, with product assignments', () => {
    const preview = generateScheduleFromSpatialHierarchy(buildMockStore(), {
      ...DEFAULT_OPTIONS,
      startDate: '2024-05-01T08:00:00',
      daysPerGroup: 5,
      lagDays: 0,
      linkSequences: true,
      order: 'bottom-up',
    });
    assert.strictEqual(preview.empty, false);
    assert.strictEqual(preview.groupCount, 3);
    assert.strictEqual(preview.productCount, 6);
    assert.strictEqual(preview.extraction.tasks.length, 3);
    assert.deepStrictEqual(
      preview.extraction.tasks.map(t => t.name),
      ['Ground', 'Level 1', 'Roof'],
    );
    assert.deepStrictEqual(
      preview.extraction.tasks[0].productExpressIds,
      [1, 2, 3],
    );
    assert.deepStrictEqual(
      preview.extraction.tasks[0].productGlobalIds,
      ['wall-A', 'wall-B', 'slab-G'],
    );
    // Finish-Start sequences between consecutive storeys.
    assert.strictEqual(preview.extraction.sequences.length, 2);
    assert.strictEqual(
      preview.extraction.sequences[0].sequenceType,
      'FINISH_START',
    );
  });

  it('top-down order reverses the task list', () => {
    const preview = generateScheduleFromSpatialHierarchy(buildMockStore(), {
      ...DEFAULT_OPTIONS,
      startDate: '2024-05-01T08:00:00',
      order: 'top-down',
    });
    assert.deepStrictEqual(
      preview.extraction.tasks.map(t => t.name),
      ['Roof', 'Level 1', 'Ground'],
    );
  });

  it('laying out dates — no lag', () => {
    const preview = generateScheduleFromSpatialHierarchy(buildMockStore(), {
      ...DEFAULT_OPTIONS,
      startDate: '2024-05-01T00:00:00',
      daysPerGroup: 5,
      lagDays: 0,
    });
    const starts = preview.extraction.tasks.map(t => t.taskTime?.scheduleStart);
    assert.deepStrictEqual(starts, [
      '2024-05-01T00:00:00',
      '2024-05-06T00:00:00',
      '2024-05-11T00:00:00',
    ]);
    assert.strictEqual(preview.finishDate, '2024-05-16T00:00:00');
  });

  it('laying out dates — 2-day lag', () => {
    const preview = generateScheduleFromSpatialHierarchy(buildMockStore(), {
      ...DEFAULT_OPTIONS,
      startDate: '2024-05-01T00:00:00',
      daysPerGroup: 5,
      lagDays: 2,
    });
    const starts = preview.extraction.tasks.map(t => t.taskTime?.scheduleStart);
    assert.deepStrictEqual(starts, [
      '2024-05-01T00:00:00',
      '2024-05-08T00:00:00',
      '2024-05-15T00:00:00',
    ]);
    // Sequence edges get the lag duration attached.
    assert.strictEqual(
      preview.extraction.sequences[0].timeLagDuration,
      'P2D',
    );
    assert.strictEqual(
      preview.extraction.sequences[0].timeLagSeconds,
      2 * 86_400,
    );
  });

  it('skipEmptyGroups drops storeys with no products', () => {
    const store = buildMockStore();
    // Replace the Roof storey with an empty one.
    (store.spatialHierarchy!.byStorey as Map<number, number[]>).set(102, []);

    const preview = generateScheduleFromSpatialHierarchy(store, {
      ...DEFAULT_OPTIONS,
      skipEmptyGroups: true,
    });
    assert.strictEqual(preview.groupCount, 2);
    assert.deepStrictEqual(
      preview.extraction.tasks.map(t => t.name),
      ['Ground', 'Level 1'],
    );

    const preview2 = generateScheduleFromSpatialHierarchy(store, {
      ...DEFAULT_OPTIONS,
      skipEmptyGroups: false,
    });
    assert.strictEqual(preview2.groupCount, 3);
  });

  it('linkSequences=false produces a flat list of tasks', () => {
    const preview = generateScheduleFromSpatialHierarchy(buildMockStore(), {
      ...DEFAULT_OPTIONS,
      linkSequences: false,
    });
    assert.strictEqual(preview.extraction.sequences.length, 0);
  });

  it('attaches every task to the generated work schedule', () => {
    const preview = generateScheduleFromSpatialHierarchy(buildMockStore(), DEFAULT_OPTIONS);
    const scheduleGid = preview.extraction.workSchedules[0].globalId;
    for (const task of preview.extraction.tasks) {
      assert.ok(task.controllingScheduleGlobalIds.includes(scheduleGid));
    }
    assert.strictEqual(
      preview.extraction.workSchedules[0].taskGlobalIds.length,
      preview.extraction.tasks.length,
    );
  });
});

describe('generateScheduleFromSpatialHierarchy — building strategy', () => {
  it('produces one task per building rolling up all products', () => {
    const preview = generateScheduleFromSpatialHierarchy(buildMockStore(), {
      ...DEFAULT_OPTIONS,
      strategy: 'IfcBuilding',
    });
    assert.strictEqual(preview.groupCount, 1);
    assert.strictEqual(preview.productCount, 6);
  });
});

describe('empty / degenerate inputs', () => {
  it('returns empty preview for null store', () => {
    const preview = generateScheduleFromSpatialHierarchy(null, DEFAULT_OPTIONS);
    assert.strictEqual(preview.empty, true);
    assert.strictEqual(preview.extraction.hasSchedule, false);
  });

  it('returns empty preview when every storey is empty and skipEmpty=true', () => {
    const store = buildMockStore();
    const by = store.spatialHierarchy!.byStorey as Map<number, number[]>;
    by.set(100, []); by.set(101, []); by.set(102, []);
    const preview = generateScheduleFromSpatialHierarchy(store, {
      ...DEFAULT_OPTIONS,
      strategy: 'IfcBuildingStorey',
      skipEmptyGroups: true,
    });
    // byBuilding still has products so the helper isn't technically empty —
    // it just has 0 storey groups. Assert groupCount explicitly.
    assert.strictEqual(preview.groupCount, 0);
    assert.strictEqual(preview.extraction.tasks.length, 0);
  });
});

describe('deterministic globalIds', () => {
  it('re-running against the same model produces identical task IDs', () => {
    const a = generateScheduleFromSpatialHierarchy(buildMockStore(), DEFAULT_OPTIONS);
    const b = generateScheduleFromSpatialHierarchy(buildMockStore(), DEFAULT_OPTIONS);
    assert.deepStrictEqual(
      a.extraction.tasks.map(t => t.globalId),
      b.extraction.tasks.map(t => t.globalId),
    );
    assert.strictEqual(
      a.extraction.workSchedules[0].globalId,
      b.extraction.workSchedules[0].globalId,
    );
  });

  it('different models produce different task IDs', () => {
    // Two models with disjoint container globalIds must not collide.
    const storeA = buildMockStore();
    const storeB = buildMockStore();
    // Re-key storeB's storey ids so `entities.getGlobalId` returns new values.
    const storeyRemap = new Map<number, string>([
      [100, 'DIFF-ground'], [101, 'DIFF-L1'], [102, 'DIFF-roof'],
    ]);
    const originalGetGlobalId = storeB.entities.getGlobalId.bind(storeB.entities);
    (storeB.entities as unknown as { getGlobalId: (id: number) => string }).getGlobalId = (id: number) =>
      storeyRemap.get(id) ?? originalGetGlobalId(id);

    const a = generateScheduleFromSpatialHierarchy(storeA, DEFAULT_OPTIONS);
    const b = generateScheduleFromSpatialHierarchy(storeB, DEFAULT_OPTIONS);
    const idsA = new Set(a.extraction.tasks.map(t => t.globalId));
    const idsB = new Set(b.extraction.tasks.map(t => t.globalId));
    for (const id of idsB) assert.ok(!idsA.has(id), `id ${id} collided across models`);
  });

  it('100 distinct seeds map to 100 distinct GlobalIds (hash-collision regression)', () => {
    // Regression: the single-stream 32-bit FNV variant we shipped
    // collided on real-world 30-task schedules — duplicate task
    // GlobalIds caused downstream Gantt bars to overwrite each other,
    // producing bars scattered across months instead of a clean
    // sequence. The two-stream mixer is sized so 100 seeds never
    // collide; this guards against regressing to the weaker variant.
    const entitiesByExpressId = new Map<number, { name: string; globalId: string }>();
    const byStorey = new Map<number, number[]>();
    const storeyElevations = new Map<number, number>();
    for (let i = 0; i < 100; i++) {
      const storeyId = 1000 + i;
      // Use realistic IFC 22-char GUIDs so we're stressing the same
      // input shape as production (not short "storey-0001" stubs).
      const gid = `Storey-${i.toString().padStart(17, 'A')}`;
      entitiesByExpressId.set(storeyId, { name: `Level ${i}`, globalId: gid });
      byStorey.set(storeyId, [i + 1]); // one element per storey so none are skipped
      storeyElevations.set(storeyId, i * 3.0);
    }

    const stressStore = {
      spatialHierarchy: {
        project: { expressId: 0, type: 0, name: 'Project', children: [], elements: [] },
        byStorey,
        byBuilding: new Map([[99, Array.from(byStorey.values()).flat()]]),
        bySite: new Map(),
        bySpace: new Map(),
        storeyElevations,
        storeyHeights: new Map(),
        elementToStorey: new Map(),
        getStoreyElements: () => [],
        getStoreyByElevation: () => null,
        getContainingSpace: () => null,
        getPath: () => [],
      },
      entities: {
        getName: (id: number) => entitiesByExpressId.get(id)?.name ?? '',
        getGlobalId: (id: number) => entitiesByExpressId.get(id)?.globalId ?? '',
      },
      // Required IfcDataStore surface — unused by this codepath but
      // satisfies the type so we don't have to cast through `unknown`.
      properties: null,
      entityCount: 0,
      schemaVersion: 'IFC4',
    } as unknown as IfcDataStore;

    const preview = generateScheduleFromSpatialHierarchy(stressStore, DEFAULT_OPTIONS);
    const ids = preview.extraction.tasks.map(t => t.globalId);
    assert.strictEqual(ids.length, 100, 'expected 100 tasks');
    const unique = new Set(ids);
    assert.strictEqual(unique.size, 100, `GlobalId collisions: ${ids.length - unique.size}`);
    // Workschedule id must also be distinct from every task id.
    const wsId = preview.extraction.workSchedules[0]!.globalId;
    assert.ok(!unique.has(wsId), `workschedule id ${wsId} collides with a task`);
  });
});

describe('generateScheduleFromSpatialHierarchy — IfcElement (Z slice) strategy', () => {
  // Build a synthetic mesh for a product — vertical coord on Y (WebGL
  // Y-up, matching the parser's `convertZUpToYUp` output) controls the
  // bin; ifcType controls the "class" subgroup; name/type routed
  // through the entities shim.
  const makeMesh = (expressId: number, y: number, ifcType = 'IfcWall') => ({
    expressId,
    ifcType,
    // 3 vertices at (x, y, z) = (0,y,0), (1,y,0), (0,y,1) — all at the
    // same vertical so the centroid equals `y` exactly.
    positions: new Float32Array([0, y, 0, 1, y, 0, 0, y, 1]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1] as [number, number, number, number],
  });

  const baseStore = (): IfcDataStore => {
    const nameByLocal = new Map<number, { name: string; globalId: string; typeName: string }>([
      [1, { name: 'Wall A', globalId: 'W-A', typeName: 'WallType-100' }],
      [2, { name: 'Wall B', globalId: 'W-B', typeName: 'WallType-100' }],
      [3, { name: 'Slab L1', globalId: 'S-L1', typeName: 'SlabType-S1' }],
      [4, { name: 'Slab L2', globalId: 'S-L2', typeName: 'SlabType-S1' }],
      [5, { name: 'Col High', globalId: 'C-Hi', typeName: 'ColType-X' }],
    ]);
    return {
      spatialHierarchy: undefined,
      entities: {
        getName: (id: number) => nameByLocal.get(id)?.name ?? '',
        getGlobalId: (id: number) => nameByLocal.get(id)?.globalId ?? '',
        getTypeName: (id: number) => nameByLocal.get(id)?.typeName ?? '',
      },
    } as unknown as IfcDataStore;
  };

  it('is empty when no geometry is supplied', () => {
    const preview = generateScheduleFromSpatialHierarchy(
      baseStore(),
      { ...DEFAULT_OPTIONS, strategy: 'IfcElement' },
    );
    assert.strictEqual(preview.empty, true);
  });

  it('bins by mesh centroid Z (tolerance = slice height), subgroup=none', () => {
    const meshes = [
      makeMesh(1, 0.2), makeMesh(2, 1.1),  // bin 0 (0-3 m)
      makeMesh(3, 3.5), makeMesh(4, 4.9),  // bin 1 (3-6 m)
      makeMesh(5, 9.8),                     // bin 3 (9-12 m) — note gap is fine
    ];
    const preview = generateScheduleFromSpatialHierarchy(
      baseStore(),
      { ...DEFAULT_OPTIONS, strategy: 'IfcElement', heightTolerance: 3, elementZSubgroup: 'none' },
      { meshes: meshes as unknown as import('@ifc-lite/geometry').MeshData[], idOffset: 0 },
    );
    assert.strictEqual(preview.empty, false);
    assert.strictEqual(preview.groupCount, 3);
    // Products in the first bin: 1 and 2.
    const task0 = preview.extraction.tasks[0]!;
    assert.deepEqual(task0.productExpressIds.sort(), [1, 2]);
    const task1 = preview.extraction.tasks[1]!;
    assert.deepEqual(task1.productExpressIds.sort(), [3, 4]);
    const task2 = preview.extraction.tasks[2]!;
    assert.deepEqual(task2.productExpressIds, [5]);
  });

  it('subdivides each slice by IFC class when subgroup=class', () => {
    const meshes = [
      makeMesh(1, 0.5, 'IfcWall'),
      makeMesh(2, 0.8, 'IfcWall'),
      makeMesh(3, 1.2, 'IfcSlab'),
      makeMesh(4, 4.5, 'IfcWall'),
    ];
    const preview = generateScheduleFromSpatialHierarchy(
      baseStore(),
      { ...DEFAULT_OPTIONS, strategy: 'IfcElement', heightTolerance: 3, elementZSubgroup: 'class' },
      { meshes: meshes as unknown as import('@ifc-lite/geometry').MeshData[], idOffset: 0 },
    );
    // bin 0 × { IfcWall, IfcSlab } + bin 1 × { IfcWall } = 3 tasks.
    assert.strictEqual(preview.groupCount, 3);
    const walls0 = preview.extraction.tasks.find(t => t.name.startsWith('IfcWall') && t.productExpressIds.includes(1));
    assert.ok(walls0, 'expected IfcWall task in bin 0');
    assert.deepEqual(walls0!.productExpressIds.sort(), [1, 2]);
  });

  it('respects idOffset when converting mesh.expressId to local', () => {
    // idOffset=1000: mesh with expressId=1001 → local=1.
    const meshes = [makeMesh(1001, 0.5)];
    const preview = generateScheduleFromSpatialHierarchy(
      baseStore(),
      { ...DEFAULT_OPTIONS, strategy: 'IfcElement', heightTolerance: 3, elementZSubgroup: 'none' },
      { meshes: meshes as unknown as import('@ifc-lite/geometry').MeshData[], idOffset: 1000 },
    );
    assert.deepEqual(preview.extraction.tasks[0]!.productExpressIds, [1]);
  });

  it('emits unique task globalIds across bins and subkeys', () => {
    const meshes: ReturnType<typeof makeMesh>[] = [];
    for (let i = 0; i < 20; i++) meshes.push(makeMesh(i + 1, i * 0.5, i % 2 === 0 ? 'IfcWall' : 'IfcSlab'));
    const preview = generateScheduleFromSpatialHierarchy(
      baseStore(),
      { ...DEFAULT_OPTIONS, strategy: 'IfcElement', heightTolerance: 2, elementZSubgroup: 'class' },
      { meshes: meshes as unknown as import('@ifc-lite/geometry').MeshData[], idOffset: 0 },
    );
    const ids = preview.extraction.tasks.map(t => t.globalId);
    assert.strictEqual(new Set(ids).size, ids.length, `${ids.length - new Set(ids).size} collisions`);
  });
});

describe('toLocalIso', () => {
  it('emits a stable zero-padded local-timezone ISO string', () => {
    const d = new Date(2024, 4, 1, 8, 5, 9); // May 1, 08:05:09
    assert.strictEqual(toLocalIso(d), '2024-05-01T08:05:09');
  });
});
