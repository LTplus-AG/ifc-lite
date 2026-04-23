/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { __schedule_schema_testing as S } from './bridge-schedule.js';

describe('bridge-schedule — schema-driven type emission', () => {
  it('emits every TaskTime field the schema declares', () => {
    // Pin the shape of the generated return type so a schema edit
    // produces a visible test-diff. Every field from TASK_TIME_FIELDS
    // must appear exactly once in the return string.
    for (const f of S.TASK_TIME_FIELDS) {
      const expected = `${f.pascalKey}${f.optional ? '?' : ''}: ${f.tsType}`;
      expect(S.TASK_TIME_RETURN).toContain(expected);
    }
  });

  it('emits every Task field + nested TaskTime reference', () => {
    for (const f of S.TASK_FIELDS) {
      const expected = `${f.pascalKey}${f.optional ? '?' : ''}: ${f.tsType}`;
      expect(S.TASK_RETURN).toContain(expected);
    }
    // The nested struct appears inline (not by reference) so LLM scripts
    // can auto-complete TaskTime fields from the main Task type.
    expect(S.TASK_RETURN).toContain('TaskTime?: ');
  });

  it('emits every WorkSchedule field', () => {
    for (const f of S.WORK_SCHEDULE_FIELDS) {
      const expected = `${f.pascalKey}${f.optional ? '?' : ''}: ${f.tsType}`;
      expect(S.WORK_SCHEDULE_RETURN).toContain(expected);
    }
  });

  it('emits every Sequence field', () => {
    for (const f of S.SEQUENCE_FIELDS) {
      const expected = `${f.pascalKey}${f.optional ? '?' : ''}: ${f.tsType}`;
      expect(S.SEQUENCE_RETURN).toContain(expected);
    }
  });
});

describe('bridge-schedule — schema-driven key translation', () => {
  it('translateTask: camelCase source → PascalCase output for every schema field', () => {
    const internal = {
      globalId: 'g-1',
      expressId: 42,
      name: 'Erect wall',
      description: 'desc',
      objectType: 'ot',
      identification: 'id-1',
      longDescription: 'long',
      status: 'active',
      workMethod: 'manual',
      isMilestone: false,
      priority: 5,
      predefinedType: 'CONSTRUCTION',
      parentGlobalId: 'parent-1',
      childGlobalIds: ['c-1', 'c-2'],
      productExpressIds: [101, 102],
      productGlobalIds: ['pg-1'],
      controllingScheduleGlobalIds: ['cs-1'],
      taskTime: {
        scheduleStart: '2024-05-01T08:00:00',
        scheduleFinish: '2024-05-03T17:00:00',
        isCritical: true,
      },
    };
    const out = S.translateTask(internal);
    expect(out.GlobalId).toBe('g-1');
    expect(out.Name).toBe('Erect wall');
    expect(out.ParentTaskGlobalId).toBe('parent-1');
    expect(out.ChildTaskGlobalIds).toEqual(['c-1', 'c-2']);
    expect(out.AssignedProductExpressIds).toEqual([101, 102]);
    expect(out.ControllingScheduleGlobalIds).toEqual(['cs-1']);
    const tt = out.TaskTime as { ScheduleStart: string; IsCritical: boolean };
    expect(tt.ScheduleStart).toBe('2024-05-01T08:00:00');
    expect(tt.IsCritical).toBe(true);
  });

  it('translateTaskTime returns undefined for absent nested time', () => {
    expect(S.translateTaskTime(undefined)).toBeUndefined();
    expect(S.translateTaskTime(null)).toBeUndefined();
  });

  it('translateWorkSchedule: camelCase → PascalCase', () => {
    const ws = {
      globalId: 'ws-1',
      expressId: 10,
      name: 'WS',
      kind: 'WorkSchedule' as const,
      taskGlobalIds: ['t-1', 't-2'],
    };
    const out = S.translateWorkSchedule(ws);
    expect(out.GlobalId).toBe('ws-1');
    expect(out.Kind).toBe('WorkSchedule');
    expect(out.TaskGlobalIds).toEqual(['t-1', 't-2']);
  });

  it('translateSequence: uses RelatingProcessGlobalId / RelatedProcessGlobalId (IFC-correct naming)', () => {
    // Deliberate: the internal struct uses relatingTaskGlobalId/relatedTaskGlobalId,
    // but IFC EXPRESS names the IfcRelSequence attrs RelatingProcess/RelatedProcess.
    // The schema enforces IFC-correct on the public side.
    const seq = {
      relatingTaskGlobalId: 'a',
      relatedTaskGlobalId: 'b',
      sequenceType: 'FINISH_START' as const,
      timeLagSeconds: 86400,
    };
    const out = S.translateSequence(seq);
    expect(out.RelatingProcessGlobalId).toBe('a');
    expect(out.RelatedProcessGlobalId).toBe('b');
    expect(out.SequenceType).toBe('FINISH_START');
    expect(out.TimeLagSeconds).toBe(86400);
  });

  it('translateData: composes the full extraction', () => {
    const d = {
      hasSchedule: true,
      workSchedules: [{ globalId: 'ws', expressId: 1, name: 'WS', kind: 'WorkSchedule', taskGlobalIds: [] }],
      tasks: [{
        globalId: 't', expressId: 2, name: 'T', isMilestone: false,
        childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
        controllingScheduleGlobalIds: [],
      }],
      sequences: [],
    };
    const out = S.translateData(d);
    expect(out.HasSchedule).toBe(true);
    expect(Array.isArray(out.WorkSchedules)).toBe(true);
    expect(Array.isArray(out.Tasks)).toBe(true);
    expect(Array.isArray(out.Sequences)).toBe(true);
    expect((out.Tasks as Record<string, unknown>[])[0].GlobalId).toBe('t');
  });
});

describe('bridge-schedule — no schema / translator drift', () => {
  it('every TASK_FIELDS pascalKey is a unique identifier (no accidental duplicates)', () => {
    const keys = S.TASK_FIELDS.map(f => f.pascalKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every WORK_SCHEDULE_FIELDS / SEQUENCE_FIELDS pascalKey is unique', () => {
    for (const fields of [S.WORK_SCHEDULE_FIELDS, S.SEQUENCE_FIELDS, S.TASK_TIME_FIELDS]) {
      const keys = fields.map(f => f.pascalKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('every TASK_FIELDS camelKey is also unique (no two fields share a source key)', () => {
    const keys = S.TASK_FIELDS.map(f => f.camelKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('DATA_RETURN composes nested types correctly', () => {
    // Defensive: ensure we didn't break the composition on rebuild.
    expect(S.DATA_RETURN).toContain('HasSchedule: boolean');
    expect(S.DATA_RETURN).toContain(`WorkSchedules: Array<${S.WORK_SCHEDULE_RETURN}>`);
    expect(S.DATA_RETURN).toContain(`Tasks: Array<${S.TASK_RETURN}>`);
    expect(S.DATA_RETURN).toContain(`Sequences: Array<${S.SEQUENCE_RETURN}>`);
  });
});
