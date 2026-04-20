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
});

describe('toLocalIso', () => {
  it('emits a stable zero-padded local-timezone ISO string', () => {
    const d = new Date(2024, 4, 1, 8, 5, 9); // May 1, 08:05:09
    assert.strictEqual(toLocalIso(d), '2024-05-01T08:05:09');
  });
});
