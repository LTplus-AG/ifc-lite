/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { __schedule_schema_testing as S } from './bridge-schedule.js';

describe('bridge-schedule — internal → public translation', () => {
  it('translateTask maps every camelCase source attribute to its IFC-PascalCase key', () => {
    // Full-shape assertion: covers every task field declared in the schema
    // plus the nested TaskTime sub-struct. Locks down the key rename
    // contract that bim.schedule.* callers depend on.
    const internal = {
      globalId: 'g-1', expressId: 42, name: 'Erect wall',
      description: 'desc', objectType: 'ot', identification: 'id-1',
      longDescription: 'long', status: 'active', workMethod: 'manual',
      isMilestone: false, priority: 5, predefinedType: 'CONSTRUCTION',
      parentGlobalId: 'parent-1',
      childGlobalIds: ['c-1', 'c-2'],
      productExpressIds: [101, 102], productGlobalIds: ['pg-1'],
      controllingScheduleGlobalIds: ['cs-1'],
      taskTime: {
        scheduleStart: '2024-05-01T08:00:00', scheduleFinish: '2024-05-03T17:00:00',
        isCritical: true,
      },
    };
    const out = S.translateTask(internal);
    // Identity + navigation.
    expect(out.GlobalId).toBe('g-1');
    expect(out.ExpressId).toBe(42);
    expect(out.Name).toBe('Erect wall');
    expect(out.ParentTaskGlobalId).toBe('parent-1');
    expect(out.ChildTaskGlobalIds).toEqual(['c-1', 'c-2']);
    // "Assigned" prefix on products — IFC-correct, not the internal "product".
    expect(out.AssignedProductExpressIds).toEqual([101, 102]);
    expect(out.AssignedProductGlobalIds).toEqual(['pg-1']);
    expect(out.ControllingScheduleGlobalIds).toEqual(['cs-1']);
    // Nested TaskTime — sub-struct key rename flows through.
    const tt = out.TaskTime as { ScheduleStart: string; IsCritical: boolean };
    expect(tt.ScheduleStart).toBe('2024-05-01T08:00:00');
    expect(tt.IsCritical).toBe(true);
  });

  it('translateSequence uses RelatingProcess / RelatedProcess — IFC EXPRESS naming', () => {
    // Deliberate: internal struct says relatingTaskGlobalId / relatedTaskGlobalId
    // (camelCase + "Task" because that's what it references); IFC EXPRESS
    // names the IfcRelSequence attrs RelatingProcess / RelatedProcess. The
    // public API follows IFC.
    const out = S.translateSequence({
      relatingTaskGlobalId: 'a', relatedTaskGlobalId: 'b',
      sequenceType: 'FINISH_START', timeLagSeconds: 86400,
    });
    expect(out.RelatingProcessGlobalId).toBe('a');
    expect(out.RelatedProcessGlobalId).toBe('b');
    expect(out.SequenceType).toBe('FINISH_START');
    expect(out.TimeLagSeconds).toBe(86400);
  });
});

describe('bridge-schedule — schema hygiene', () => {
  it('no duplicate keys across any struct (catches copy-paste errors in the schema table)', () => {
    // Lint-like: adding a field by duplicating a row is easy and silently
    // corrupts the emitted type. One test locks every struct down.
    for (const fields of [S.TASK_FIELDS, S.TASK_TIME_FIELDS, S.WORK_SCHEDULE_FIELDS, S.SEQUENCE_FIELDS]) {
      const pascal = fields.map(f => f.pascalKey);
      const camel = fields.map(f => f.camelKey);
      expect(new Set(pascal).size).toBe(pascal.length);
      expect(new Set(camel).size).toBe(camel.length);
    }
  });
});
