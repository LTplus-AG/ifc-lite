/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { extractScheduleOnDemand, parseIso8601Duration } from '../src/schedule-extractor.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';

/**
 * Minimal in-memory IfcDataStore builder for tests — mirrors the helper used in
 * other on-demand extractor suites. Each `line` is a full STEP statement;
 * byteOffset/byteLength are computed by matching the line in the composed text.
 */
function buildStoreFromStep(
  lines: string[],
  opts?: {
    schemaVersion?: IfcDataStore['schemaVersion'];
    globalIdByExpressId?: Map<number, string>;
  },
): IfcDataStore {
  const text = lines.join('\n');
  const source = new TextEncoder().encode(text);

  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();

  let cursor = 0;
  for (const line of lines) {
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (match) {
      const expressId = parseInt(match[1], 10);
      const type = match[2];
      const idx = text.indexOf(line, cursor);
      const byteOffset = idx >= 0 ? idx : cursor;
      const ref: EntityRef = {
        expressId,
        type,
        byteOffset,
        byteLength: line.length,
        lineNumber: 1,
      };
      byId.set(expressId, ref);
      const typeUpper = type.toUpperCase();
      let list = byType.get(typeUpper);
      if (!list) {
        list = [];
        byType.set(typeUpper, list);
      }
      list.push(expressId);
      cursor = byteOffset + line.length + 1; // +1 for newline
    }
  }

  const gidMap = opts?.globalIdByExpressId ?? new Map<number, string>();
  const entities = {
    getGlobalId: (id: number) => gidMap.get(id) ?? '',
    getName: (id: number) => `entity${id}`,
  };

  return {
    source,
    schemaVersion: opts?.schemaVersion ?? 'IFC4',
    entityIndex: { byId, byType },
    entities,
  } as unknown as IfcDataStore;
}

describe('parseIso8601Duration', () => {
  it('parses days', () => {
    expect(parseIso8601Duration('P1D')).toBe(86400);
    expect(parseIso8601Duration('P2D')).toBe(2 * 86400);
  });

  it('parses hours/minutes/seconds', () => {
    expect(parseIso8601Duration('PT1H')).toBe(3600);
    expect(parseIso8601Duration('PT1H30M')).toBe(3600 + 30 * 60);
    expect(parseIso8601Duration('PT45S')).toBe(45);
  });

  it('parses weeks', () => {
    expect(parseIso8601Duration('P2W')).toBe(14 * 86400);
  });

  it('returns undefined on invalid', () => {
    expect(parseIso8601Duration('not a duration')).toBeUndefined();
    expect(parseIso8601Duration('')).toBeUndefined();
    expect(parseIso8601Duration(undefined)).toBeUndefined();
  });
});

describe('extractScheduleOnDemand', () => {
  it('returns empty extraction with hasSchedule=false when no tasks', () => {
    const store = buildStoreFromStep(["#1=IFCWALL('wall-gid',$,'W',$,$,$,$,$,$);"]);
    const result = extractScheduleOnDemand(store);
    expect(result.hasSchedule).toBe(false);
    expect(result.tasks).toEqual([]);
    expect(result.workSchedules).toEqual([]);
    expect(result.sequences).toEqual([]);
  });

  it('extracts IfcTask with TaskTime (IFC4 layout)', () => {
    // IfcTaskTime: [Name, DataOrigin, UserDefinedDataOrigin, DurationType,
    //   ScheduleDuration, ScheduleStart, ScheduleFinish, ...]
    // IfcTask (IFC4):
    //   [GlobalId, OwnerHistory, Name, Description, ObjectType, Identification,
    //    LongDescription, Status, WorkMethod, IsMilestone, Priority, TaskTime,
    //    PredefinedType]
    const lines = [
      "#10=IFCTASKTIME($,$,$,.WORKTIME.,'P5D','2024-01-01T08:00:00','2024-01-06T17:00:00',$,$,$,$,$,$,.F.,$,$,$,$,$,$);",
      "#20=IFCTASK('task-1-gid',$,'Install walls','desc','constr','T1','Full install','NotStarted','Manual',.F.,$,#10,.CONSTRUCTION.);",
    ];
    const store = buildStoreFromStep(lines);
    const result = extractScheduleOnDemand(store);
    expect(result.hasSchedule).toBe(true);
    expect(result.tasks).toHaveLength(1);
    const t = result.tasks[0];
    expect(t.globalId).toBe('task-1-gid');
    expect(t.name).toBe('Install walls');
    expect(t.identification).toBe('T1');
    expect(t.predefinedType).toBe('CONSTRUCTION');
    expect(t.isMilestone).toBe(false);
    expect(t.taskTime?.scheduleStart).toBe('2024-01-01T08:00:00');
    expect(t.taskTime?.scheduleFinish).toBe('2024-01-06T17:00:00');
    expect(t.taskTime?.scheduleDuration).toBe('P5D');
    expect(t.taskTime?.durationType).toBe('WORKTIME');
    expect(t.taskTime?.isCritical).toBe(false);
  });

  it('links assigned products via IfcRelAssignsToProcess', () => {
    const lines = [
      "#1=IFCWALL('wall-A-gid',$,'Wall A',$,$,$,$,$,$);",
      "#2=IFCWALL('wall-B-gid',$,'Wall B',$,$,$,$,$,$);",
      "#10=IFCTASKTIME($,$,$,.WORKTIME.,'P2D','2024-01-01T00:00:00','2024-01-03T00:00:00',$,$,$,$,$,$,$,$,$,$,$,$,$);",
      "#20=IFCTASK('task-gid',$,'Install',$,$,$,$,$,$,.F.,$,#10,.CONSTRUCTION.);",
      "#30=IFCRELASSIGNSTOPROCESS('rel-gid',$,$,$,(#1,#2),$,#20,$);",
    ];
    const store = buildStoreFromStep(lines, {
      globalIdByExpressId: new Map([[1, 'wall-A-gid'], [2, 'wall-B-gid']]),
    });
    const result = extractScheduleOnDemand(store);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].productExpressIds).toEqual([1, 2]);
    expect(result.tasks[0].productGlobalIds).toEqual(['wall-A-gid', 'wall-B-gid']);
  });

  it('builds parent/child hierarchy via IfcRelNests', () => {
    const lines = [
      "#10=IFCTASK('root-gid',$,'Project',$,$,$,$,$,$,.F.,$,$,$);",
      "#11=IFCTASK('child-a-gid',$,'Foundation',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
      "#12=IFCTASK('child-b-gid',$,'Framing',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
      "#20=IFCRELNESTS('rel-gid',$,$,$,#10,(#11,#12));",
    ];
    const store = buildStoreFromStep(lines);
    const result = extractScheduleOnDemand(store);
    const root = result.tasks.find(t => t.globalId === 'root-gid');
    const a = result.tasks.find(t => t.globalId === 'child-a-gid');
    const b = result.tasks.find(t => t.globalId === 'child-b-gid');
    expect(root?.childGlobalIds).toEqual(['child-a-gid', 'child-b-gid']);
    expect(a?.parentGlobalId).toBe('root-gid');
    expect(b?.parentGlobalId).toBe('root-gid');
  });

  it('extracts IfcRelSequence dependencies with lag time', () => {
    const lines = [
      "#10=IFCTASK('pred-gid',$,'Predecessor',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
      "#11=IFCTASK('succ-gid',$,'Successor',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
      "#12=IFCLAGTIME($,$,$,IFCDURATION('P2D'),.WORKTIME.);",
      "#20=IFCRELSEQUENCE('seq-gid',$,$,$,#10,#11,#12,.FINISH_START.,$);",
    ];
    const store = buildStoreFromStep(lines);
    const result = extractScheduleOnDemand(store);
    expect(result.sequences).toHaveLength(1);
    expect(result.sequences[0].relatingTaskGlobalId).toBe('pred-gid');
    expect(result.sequences[0].relatedTaskGlobalId).toBe('succ-gid');
    expect(result.sequences[0].sequenceType).toBe('FINISH_START');
    expect(result.sequences[0].timeLagSeconds).toBe(2 * 86400);
    expect(result.sequences[0].timeLagDuration).toBe('P2D');
  });

  it('associates tasks with a work schedule via IfcRelAssignsToControl', () => {
    const lines = [
      "#10=IFCTASK('task-a-gid',$,'Task A',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
      "#11=IFCTASK('task-b-gid',$,'Task B',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
      "#30=IFCWORKSCHEDULE('sched-gid',$,'Main schedule','desc','Planning','S1','2024-01-01T00:00:00',$,'Construction',$,$,'2024-01-01T00:00:00','2024-06-01T00:00:00',.PLANNED.);",
      "#40=IFCRELASSIGNSTOCONTROL('rel-gid',$,$,$,(#10,#11),$,#30);",
    ];
    const store = buildStoreFromStep(lines);
    const result = extractScheduleOnDemand(store);
    expect(result.workSchedules).toHaveLength(1);
    expect(result.workSchedules[0].globalId).toBe('sched-gid');
    expect(result.workSchedules[0].name).toBe('Main schedule');
    expect(result.workSchedules[0].predefinedType).toBe('PLANNED');
    expect(result.workSchedules[0].taskGlobalIds).toEqual(['task-a-gid', 'task-b-gid']);
    const t = result.tasks.find(x => x.globalId === 'task-a-gid');
    expect(t?.controllingScheduleGlobalIds).toEqual(['sched-gid']);
  });
});
