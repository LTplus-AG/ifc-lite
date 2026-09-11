/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Integration tests for every seam in the schedule pipeline.
 *
 * Each bug we shipped during the 4D feature work was a contract
 * mismatch at a seam — parser case sensitivity, Uint8Array injection
 * skip, schedule wipe on store-ref shift, STEP strip regex brittleness.
 * The unit tests all passed because they used mocked stores + hand-
 * written byType maps that sidestepped the real parser.
 *
 * These tests exercise the REAL parser + REAL serializer on REAL bytes
 * so contract drift between them becomes a test failure.
 *
 * Seams covered:
 *   1. Serializer → parser (round-trip a generated schedule through the
 *      real columnar parser, confirm extractScheduleOnDemand finds
 *      everything it just wrote).
 *   2. Mixed case (IFCTask/ifctask in the input STEP — parser must
 *      normalise so byType lookups don't miss).
 *   3. Strip-and-rewrite — after stripScheduleEntities, the parser
 *      finds zero schedule entities on re-parse.
 *   4. Edit round-trip — rename a task, re-parse, confirm the new name
 *      survives.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import {
  serializeScheduleToStep,
  extractScheduleOnDemand,
} from '../src/index.js';
import type { ScheduleExtraction } from '../src/schedule-extractor.js';

/**
 * Build the minimum STEP file shape the parser will accept — header +
 * DATA section with IFCPROJECT + IFCOWNERHISTORY so schedule injection
 * has an OwnerHistory to reference, plus a couple of IFCWALL entities
 * for the IfcRelAssignsToProcess wiring.
 */
function buildBaseStep(): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('test schedule roundtrip'),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    "#1=IFCPROJECT('proj-gid',#10,'RoundTripProject',$,$,$,$,$,$);",
    "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
    "#11=IFCWALL('wall-A',#10,'Wall A',$,$,$,$,$,$);",
    "#12=IFCWALL('wall-B',#10,'Wall B',$,$,$,$,$,$);",
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

function makeExtraction(): ScheduleExtraction {
  return {
    hasSchedule: true,
    workSchedules: [{
      expressId: 0,
      globalId: 'ws-round',
      kind: 'WorkSchedule',
      name: 'RoundTrip Schedule',
      creationDate: '2024-05-01T08:00:00',
      startTime: '2024-05-01T08:00:00',
      finishTime: '2024-05-10T17:00:00',
      predefinedType: 'PLANNED',
      taskGlobalIds: ['task-wall-a', 'task-wall-b'],
    }],
    tasks: [
      {
        expressId: 0,
        globalId: 'task-wall-a',
        name: 'Install Wall A',
        isMilestone: false,
        predefinedType: 'INSTALLATION',
        childGlobalIds: [],
        productExpressIds: [11],
        productGlobalIds: ['wall-A'],
        controllingScheduleGlobalIds: ['ws-round'],
        taskTime: {
          scheduleStart: '2024-05-01T08:00:00',
          scheduleFinish: '2024-05-05T17:00:00',
          scheduleDuration: 'P5D',
        },
      },
      {
        expressId: 0,
        globalId: 'task-wall-b',
        name: 'Install Wall B',
        isMilestone: false,
        predefinedType: 'INSTALLATION',
        childGlobalIds: [],
        productExpressIds: [12],
        productGlobalIds: ['wall-B'],
        controllingScheduleGlobalIds: ['ws-round'],
        taskTime: {
          scheduleStart: '2024-05-06T08:00:00',
          scheduleFinish: '2024-05-10T17:00:00',
          scheduleDuration: 'P5D',
        },
      },
    ],
    sequences: [{
      globalId: 'seq-ab',
      relatingTaskGlobalId: 'task-wall-a',
      relatedTaskGlobalId: 'task-wall-b',
      sequenceType: 'FINISH_START',
    }],
  };
}

/** Run the real worker-free parser on a STEP buffer. */
async function parseStep(stepText: string) {
  const buffer = new TextEncoder().encode(stepText).buffer.slice(0) as ArrayBuffer;
  const source = new Uint8Array(buffer);
  const tokenizer = new StepTokenizer(source);
  const entityRefs: Array<{
    expressId: number;
    type: string;
    byteOffset: number;
    byteLength: number;
    lineNumber: number;
  }> = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  const parser = new ColumnarParser();
  return parser.parseLite(buffer, entityRefs, {});
}

/** Splice extra lines before the final `ENDSEC;` in a STEP text. */
function splice(stepText: string, lines: string[]): string {
  const endSec = stepText.lastIndexOf('ENDSEC;');
  return stepText.slice(0, endSec) + lines.join('\n') + '\n' + stepText.slice(endSec);
}

describe('schedule roundtrip — serializer ↔ parser', () => {
  it('serialises a schedule + re-parses it + extracts every task', async () => {
    const base = buildBaseStep();
    const extraction = makeExtraction();

    const result = serializeScheduleToStep(extraction, {
      nextId: 100,
      ownerHistoryId: 10,
      resolveProductExpressId: (gid) => (gid === 'wall-A' ? 11 : gid === 'wall-B' ? 12 : undefined),
    });
    expect(result.lines.length).toBeGreaterThan(0);

    const final = splice(base, result.lines);
    const store = await parseStep(final);
    const parsed = extractScheduleOnDemand(store);

    // The parser must find both tasks + the work schedule + the sequence.
    expect(parsed.hasSchedule).toBe(true);
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.workSchedules).toHaveLength(1);
    expect(parsed.sequences).toHaveLength(1);

    // Identity preserved.
    const names = parsed.tasks.map(t => t.name).sort();
    expect(names).toEqual(['Install Wall A', 'Install Wall B']);
    expect(parsed.workSchedules[0].name).toBe('RoundTrip Schedule');
    expect(parsed.sequences[0].sequenceType).toBe('FINISH_START');

    // Dates preserved byte-for-byte.
    const taskA = parsed.tasks.find(t => t.name === 'Install Wall A')!;
    expect(taskA.taskTime?.scheduleStart).toBe('2024-05-01T08:00:00');
    expect(taskA.taskTime?.scheduleFinish).toBe('2024-05-05T17:00:00');
    expect(taskA.taskTime?.scheduleDuration).toBe('P5D');
  });

  it('handles mixed-case entity type names in the source STEP', async () => {
    // STEP spec says type names are uppercase by convention; one broken
    // writer emits mixed case. The parser normalises to uppercase in
    // byType so extractScheduleOnDemand's `get('IFCTASK')` hits.
    const mixed = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('mixed'),'2;1');",
      "FILE_NAME('','',(''),(''),'','','');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;',
      "#1=IFCPROJECT('p',#10,'P',$,$,$,$,$,$);",
      "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
      // Mixed case type name — parser must still index this.
      "#20=IfcWorkSchedule('ws',#10,'WS',$,$,$,$,$,$,$,$,$,$,.PLANNED.);",
      "#21=IFCTASKTIME($,$,$,.WORKTIME.,'P3D','2024-01-01T08:00:00','2024-01-04T08:00:00',$,$,$,$,$,$,$,$,$,$,$,$,$);",
      "#22=IfcTask('t1',#10,'T',$,$,$,$,$,$,.F.,$,#21,.CONSTRUCTION.);",
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');
    const store = await parseStep(mixed);
    const parsed = extractScheduleOnDemand(store);
    expect(parsed.hasSchedule).toBe(true);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.workSchedules).toHaveLength(1);
  });

  it('round-trips a task rename through serialize → parse', async () => {
    const extraction = makeExtraction();
    // User edited the first task's name before export.
    extraction.tasks[0].name = 'Install Wall A (REVISED)';

    const result = serializeScheduleToStep(extraction, {
      nextId: 100,
      ownerHistoryId: 10,
    });
    const final = splice(buildBaseStep(), result.lines);
    const store = await parseStep(final);
    const parsed = extractScheduleOnDemand(store);

    const renamed = parsed.tasks.find(t => t.globalId === 'task-wall-a');
    expect(renamed?.name).toBe('Install Wall A (REVISED)');
  });

  it('preserves the task globalId through the round-trip (identity survives edit)', async () => {
    // Critical for the "edited parsed schedule" rewrite path: the
    // rewriter must re-emit tasks with their original globalIds so
    // callers that track tasks by id see the same task, not a new one.
    const extraction = makeExtraction();
    const originalGid = extraction.tasks[0].globalId;

    const result = serializeScheduleToStep(extraction, {
      nextId: 100,
      ownerHistoryId: 10,
    });
    const final = splice(buildBaseStep(), result.lines);
    const store = await parseStep(final);
    const parsed = extractScheduleOnDemand(store);

    const roundtripped = parsed.tasks.find(t => t.globalId === originalGid);
    expect(roundtripped).toBeDefined();
  });

  it('preserves IfcRelAssignsToProcess wiring (task → products)', async () => {
    const extraction = makeExtraction();

    const result = serializeScheduleToStep(extraction, {
      nextId: 100,
      ownerHistoryId: 10,
      resolveProductExpressId: (gid) => (gid === 'wall-A' ? 11 : gid === 'wall-B' ? 12 : undefined),
    });
    const final = splice(buildBaseStep(), result.lines);
    const store = await parseStep(final);
    const parsed = extractScheduleOnDemand(store);

    const taskA = parsed.tasks.find(t => t.globalId === 'task-wall-a')!;
    const taskB = parsed.tasks.find(t => t.globalId === 'task-wall-b')!;
    // Products came back via the parsed IfcRelAssignsToProcess; parser
    // populates `productExpressIds` from the target object list.
    expect(taskA.productExpressIds).toContain(11);
    expect(taskB.productExpressIds).toContain(12);
  });

  it('round-trips a lead time (negative lag) through a signed IfcLagTime, seconds preserved exactly', async () => {
    // Maintainer ruling on PR #1963 (reversing an earlier drop-and-warn
    // implementation): a 2-day lead — the successor may start 2 days
    // before its predecessor finishes — is real scheduling information,
    // and dropping it is silently lossy in our own ifc-lite -> IFC ->
    // ifc-lite round trip. `timeLagDuration` is deliberately omitted here,
    // matching what build.ts produces when only `timeLagSeconds` is known
    // (e.g. IFC2X3 round-trips). The serializer's signed-duration codec
    // (packages/parser/src/iso8601-duration.ts) reconstructs `-P2D` from
    // -172800 seconds, and `parseIso8601Duration` reads the sign back on
    // import — -172800 all the way through.
    const extraction = makeExtraction();
    extraction.sequences[0].timeLagSeconds = -172_800; // -2 days
    extraction.sequences[0].timeLagDuration = undefined;

    const result = serializeScheduleToStep(extraction, {
      nextId: 100,
      ownerHistoryId: 10,
    });
    const lag = result.lines.find(l => l.includes('=IFCLAGTIME('));
    expect(lag).toBeDefined();
    expect(lag).toContain("IFCDURATION('-P2D')");

    const final = splice(buildBaseStep(), result.lines);
    const store = await parseStep(final);
    const parsed = extractScheduleOnDemand(store);

    expect(parsed.sequences).toHaveLength(1);
    expect(parsed.sequences[0].timeLagDuration).toBe('-P2D');
    expect(parsed.sequences[0].timeLagSeconds).toBe(-172_800);
  });

  it('still round-trips a genuine positive lag (regression guard for the sign change)', async () => {
    const extraction = makeExtraction();
    extraction.sequences[0].timeLagSeconds = 172_800; // 2 days
    extraction.sequences[0].timeLagDuration = undefined;

    const result = serializeScheduleToStep(extraction, {
      nextId: 100,
      ownerHistoryId: 10,
    });
    const lag = result.lines.find(l => l.includes('=IFCLAGTIME('));
    expect(lag).toBeDefined();
    expect(lag).toContain("IFCDURATION('P2D')");

    const final = splice(buildBaseStep(), result.lines);
    const store = await parseStep(final);
    const parsed = extractScheduleOnDemand(store);

    expect(parsed.sequences).toHaveLength(1);
    expect(parsed.sequences[0].timeLagDuration).toBe('P2D');
    expect(parsed.sequences[0].timeLagSeconds).toBe(172_800);
  });

  it('round-trips a standalone IfcWorkPlan added alongside a schedule (#4323)', async () => {
    // The viewer's Generate dialog can now add a standalone IfcWorkPlan
    // (apps/viewer/.../schedule-utils.ts's buildWorkPlanInfo) — a
    // WorkScheduleInfo with kind: 'WorkPlan' and an empty taskGlobalIds,
    // deliberately not grouped with the schedule via IfcRelAssignsToControl
    // or IfcRelNests (neither round-trips today). This proves the plan
    // itself — the entity the issue asked for — survives serialize+parse
    // as an independent IFCWORKPLAN with no relation invented for it.
    const extraction = makeExtraction();
    extraction.workSchedules.push({
      expressId: 0,
      globalId: 'plan-standalone',
      kind: 'WorkPlan',
      name: 'Project plan',
      taskGlobalIds: [],
    });

    const result = serializeScheduleToStep(extraction, {
      nextId: 100,
      ownerHistoryId: 10,
      resolveProductExpressId: (gid) => (gid === 'wall-A' ? 11 : gid === 'wall-B' ? 12 : undefined),
    });
    expect(result.lines.some(l => l.includes('=IFCWORKPLAN('))).toBe(true);
    // No IfcRelAssignsToControl referencing the plan — it has no
    // taskGlobalIds, so the serializer must not invent a relation for it.
    const controlRels = result.lines.filter(l => l.includes('=IFCRELASSIGNSTOCONTROL('));
    expect(controlRels).toHaveLength(1); // only the schedule's own task assignment

    const final = splice(buildBaseStep(), result.lines);
    const store = await parseStep(final);
    const parsed = extractScheduleOnDemand(store);

    expect(parsed.workSchedules).toHaveLength(2);
    const plan = parsed.workSchedules.find(ws => ws.kind === 'WorkPlan');
    expect(plan).toBeDefined();
    expect(plan!.name).toBe('Project plan');
    // Standalone: no tasks resolve as controlled by the plan.
    expect(plan!.taskGlobalIds).toHaveLength(0);
    const schedule = parsed.workSchedules.find(ws => ws.kind === 'WorkSchedule');
    expect(schedule).toBeDefined();
    expect(schedule!.taskGlobalIds).toHaveLength(2);
  });
});

describe('schedule roundtrip — IfcWorkPlan nests IfcWorkSchedule (IfcRelNests)', () => {
  /**
   * Minimal, hand-authored STEP fragment (not run through our own
   * serializer) modeled on buildingSMART's own IFC4 spec reference example
   * for IfcTask ("IfcTask.ifc"), which groups a work schedule under a work
   * plan via IfcRelNests:
   *
   *   #778=IFCWORKPLAN(...);
   *   #784=IFCRELNESTS('...',#owner,$,$,#778,(#794));
   *   #794=IFCWORKSCHEDULE(...);
   *
   * Asserting against this independently-authored STEP text (rather than
   * only round-tripping our own writer's output) is the point: a reader
   * that silently drops IfcRelNests whose RelatingObject is a WorkPlan
   * would still pass a self round-trip, because our writer never emitted
   * that relation either. See schedule-extractor.ts Pass 2's comment and
   * the "nesting over non-task entities" history for why that mattered.
   */
  it('reads a real-shaped WorkPlan → WorkSchedule IfcRelNests', async () => {
    const step = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('workplan nests'),'2;1');",
      "FILE_NAME('','',(''),(''),'','','');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;',
      "#1=IFCPROJECT('p',#10,'P',$,$,$,$,$,$);",
      "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
      "#778=IFCWORKPLAN('0eVhmaYyb3sBLb0LoNiW62',#10,'Work Plan #1',$,$,$,'2010-09-23T16:26:16',$,$,$,$,'2010-09-23T00:00:00',$,$);",
      "#794=IFCWORKSCHEDULE('2LoWUCZHr7YvZks8lmqjcw',#10,'Sub Schedule',$,$,$,'2010-09-23T16:26:42',$,$,$,$,'2010-09-23T00:00:00',$,.PLANNED.);",
      "#784=IFCRELNESTS('0if6u97Ln58xH$wewg0rH3',#10,$,$,#778,(#794));",
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');

    const store = await parseStep(step);
    const parsed = extractScheduleOnDemand(store);

    expect(parsed.hasSchedule).toBe(true);
    expect(parsed.workSchedules).toHaveLength(2);

    const plan = parsed.workSchedules.find(ws => ws.kind === 'WorkPlan')!;
    const schedule = parsed.workSchedules.find(ws => ws.kind === 'WorkSchedule')!;
    expect(plan).toBeDefined();
    expect(schedule).toBeDefined();

    // The grouping edge must resolve both directions.
    expect(plan.childScheduleGlobalIds).toEqual(['2LoWUCZHr7YvZks8lmqjcw']);
    expect(schedule.parentPlanGlobalId).toBe('0eVhmaYyb3sBLb0LoNiW62');
  });

  it('dedupes when two IfcRelNests entities nest the same WorkPlan/WorkSchedule pair', async () => {
    // Two distinct IFCRELNESTS entities (#784 and #785) both nest the same
    // WorkPlan (#778) -> WorkSchedule (#794) pair — the duplicate is reached
    // via two independent relation entities, not two identical iterations
    // of the same one, so a per-relation guard can't hide the gap.
    const step = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('workplan nests duplicate'),'2;1');",
      "FILE_NAME('','',(''),(''),'','','');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;',
      "#1=IFCPROJECT('p',#10,'P',$,$,$,$,$,$);",
      "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
      "#778=IFCWORKPLAN('0eVhmaYyb3sBLb0LoNiW62',#10,'Work Plan #1',$,$,$,'2010-09-23T16:26:16',$,$,$,$,'2010-09-23T00:00:00',$,$);",
      "#794=IFCWORKSCHEDULE('2LoWUCZHr7YvZks8lmqjcw',#10,'Sub Schedule',$,$,$,'2010-09-23T16:26:42',$,$,$,$,'2010-09-23T00:00:00',$,.PLANNED.);",
      "#784=IFCRELNESTS('0if6u97Ln58xH$wewg0rH3',#10,$,$,#778,(#794));",
      "#785=IFCRELNESTS('dup-rel-nests-2222222222',#10,$,$,#778,(#794));",
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');

    const store = await parseStep(step);
    const parsed = extractScheduleOnDemand(store);

    const plan = parsed.workSchedules.find(ws => ws.kind === 'WorkPlan')!;
    expect(plan).toBeDefined();
    // A duplicated relation must not duplicate the edge.
    expect(plan.childScheduleGlobalIds).toEqual(['2LoWUCZHr7YvZks8lmqjcw']);
  });

  it('writes an IfcWorkPlan → IfcWorkSchedule IfcRelNests on export, and it re-parses', async () => {
    const extraction: ScheduleExtraction = {
      hasSchedule: true,
      tasks: [],
      sequences: [],
      workSchedules: [
        {
          expressId: 0,
          globalId: 'plan-gid',
          kind: 'WorkPlan',
          name: 'The Plan',
          taskGlobalIds: [],
          childScheduleGlobalIds: ['sched-gid'],
        },
        {
          expressId: 0,
          globalId: 'sched-gid',
          kind: 'WorkSchedule',
          name: 'The Schedule',
          taskGlobalIds: [],
          childScheduleGlobalIds: [],
        },
      ],
    };

    const result = serializeScheduleToStep(extraction, { nextId: 100, ownerHistoryId: 10 });

    // Assert against the expected STEP shape directly — not only that our
    // own reader agrees with our own writer.
    const nestsLine = result.lines.find(l => l.startsWith('#') && l.includes('=IFCRELNESTS('));
    expect(nestsLine).toBeDefined();
    // WorkPlan (#100, emitted first) nests WorkSchedule (#101).
    expect(nestsLine).toMatch(/=IFCRELNESTS\('[^']+',#10,\$,\$,#100,\(#101\)\);/);
    expect(result.stats.relNests).toBe(1);

    const final = splice(buildBaseStep(), result.lines);
    const store = await parseStep(final);
    const parsed = extractScheduleOnDemand(store);

    const plan = parsed.workSchedules.find(ws => ws.kind === 'WorkPlan')!;
    const schedule = parsed.workSchedules.find(ws => ws.kind === 'WorkSchedule')!;
    expect(plan.childScheduleGlobalIds).toEqual(['sched-gid']);
    expect(schedule.parentPlanGlobalId).toBe('plan-gid');
  });
});

describe('schedule roundtrip — IfcWorkPlan groups IfcWorkSchedule via IfcRelAssignsToControl', () => {
  /**
   * `packages/create/src/ifc-creator.ts`'s `assignSchedulesToWorkPlan` (the
   * SDK's scripting bridge) groups schedules under a work plan by emitting
   * exactly `IFCRELASSIGNSTOCONTROL('gid',#owner,$,$,(refs),$,#planId)` —
   * RelatingControl the plan, RelatedObjects the schedules — never
   * IfcRelNests. Before Pass 5's fix, `schedule-extractor.ts` only resolved
   * a `RelatedObjects` entry through `taskByExpressId`, so a work schedule
   * there (not a task) fell through the `if (!task) continue;` unnoticed —
   * the grouping was dropped without a trace, symmetrically with the
   * IfcRelNests gap #4329/#4330 fixed above.
   */
  it('reads a WorkPlan grouping a WorkSchedule via IfcRelAssignsToControl (the SDK bridge shape)', async () => {
    const step = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('workplan assigns-to-control'),'2;1');",
      "FILE_NAME('','',(''),(''),'','','');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;',
      "#1=IFCPROJECT('p',#10,'P',$,$,$,$,$,$);",
      "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
      "#778=IFCWORKPLAN('0eVhmaYyb3sBLb0LoNiW62',#10,'Work Plan #1',$,$,$,$,$,$,$,$,$,$,$);",
      "#794=IFCWORKSCHEDULE('2LoWUCZHr7YvZks8lmqjcw',#10,'Sub Schedule',$,$,$,$,$,$,$,$,$,$,.PLANNED.);",
      // Exactly the shape addIfcRelAssignsToControl emits: RelatedObjects
      // then RelatingControl, RelatingControl is the WorkPlan.
      "#784=IFCRELASSIGNSTOCONTROL('rel-gid-1',#10,$,$,(#794),$,#778);",
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');

    const store = await parseStep(step);
    const parsed = extractScheduleOnDemand(store);

    expect(parsed.hasSchedule).toBe(true);
    expect(parsed.workSchedules).toHaveLength(2);

    const plan = parsed.workSchedules.find(ws => ws.kind === 'WorkPlan')!;
    const schedule = parsed.workSchedules.find(ws => ws.kind === 'WorkSchedule')!;
    expect(plan).toBeDefined();
    expect(schedule).toBeDefined();

    // The grouping edge must resolve both directions, same contract as the
    // IfcRelNests path above.
    expect(plan.childScheduleGlobalIds).toEqual(['2LoWUCZHr7YvZks8lmqjcw']);
    expect(schedule.parentPlanGlobalId).toBe('0eVhmaYyb3sBLb0LoNiW62');
    // And it must not be mistaken for a task assignment.
    expect(plan.taskGlobalIds).toHaveLength(0);
  });

  it('a WorkPlan with an unresolved IfcRelAssignsToControl stays distinguishable from one with no grouping at all', async () => {
    // RelatedObjects references an expressId that resolves to nothing (no
    // such entity) — the plan must come back with childScheduleGlobalIds
    // empty/absent, not a spurious entry, and this must not be conflated
    // with "absent = never checked".
    const step = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('workplan assigns-to-control unresolved'),'2;1');",
      "FILE_NAME('','',(''),(''),'','','');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;',
      "#1=IFCPROJECT('p',#10,'P',$,$,$,$,$,$);",
      "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
      "#778=IFCWORKPLAN('plan-unresolved',#10,'Work Plan #1',$,$,$,$,$,$,$,$,$,$,$);",
      "#784=IFCRELASSIGNSTOCONTROL('rel-gid-2',#10,$,$,(#999),$,#778);",
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');

    const store = await parseStep(step);
    const parsed = extractScheduleOnDemand(store);

    const plan = parsed.workSchedules.find(ws => ws.kind === 'WorkPlan')!;
    expect(plan).toBeDefined();
    expect(plan.childScheduleGlobalIds ?? []).toHaveLength(0);
  });

  it('the regenerate path: extraction sourced from IfcRelAssignsToControl survives serialize + reparse (canonicalized to IfcRelNests)', async () => {
    // Simulates the edit-triggered strip-and-regenerate path
    // (apps/viewer/src/sdk/adapters/export-adapter.ts): a file authored via
    // the SDK bridge (IfcRelAssignsToControl) is opened, a task edit
    // triggers extractScheduleOnDemand + serializeScheduleToStep instead of
    // byte-preservation, and the plan/schedule grouping must survive.
    const step = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('regenerate path'),'2;1');",
      "FILE_NAME('','',(''),(''),'','','');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;',
      "#1=IFCPROJECT('p',#10,'P',$,$,$,$,$,$);",
      "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
      "#778=IFCWORKPLAN('plan-regen',#10,'Work Plan',$,$,$,$,$,$,$,$,$,$,$);",
      "#794=IFCWORKSCHEDULE('sched-regen',#10,'Sub Schedule',$,$,$,$,$,$,$,$,$,$,.PLANNED.);",
      "#784=IFCRELASSIGNSTOCONTROL('rel-gid-3',#10,$,$,(#794),$,#778);",
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');

    const store = await parseStep(step);
    const opened = extractScheduleOnDemand(store);
    const openedPlan = opened.workSchedules.find(ws => ws.kind === 'WorkPlan')!;
    expect(openedPlan.childScheduleGlobalIds).toEqual(['sched-regen']);

    // Regenerate — this is the serializer path a task edit triggers.
    const result = serializeScheduleToStep(opened, { nextId: 900, ownerHistoryId: 10 });

    // The serializer canonicalizes work-plan grouping to IfcRelNests on
    // write (its only emission path for `childScheduleGlobalIds`, added by
    // #4330) regardless of which relation the source used — it does not
    // (and structurally cannot, since there is one write section) emit a
    // second IfcRelAssignsToControl for the same pair.
    const nestsLines = result.lines.filter(l => l.includes('=IFCRELNESTS('));
    expect(nestsLines).toHaveLength(1);
    const controlLines = result.lines.filter(l => l.includes('=IFCRELASSIGNSTOCONTROL('));
    expect(controlLines).toHaveLength(0);

    const final = splice(buildBaseStep(), result.lines);
    const store2 = await parseStep(final);
    const reparsed = extractScheduleOnDemand(store2);

    const plan = reparsed.workSchedules.find(ws => ws.kind === 'WorkPlan')!;
    const schedule = reparsed.workSchedules.find(ws => ws.kind === 'WorkSchedule')!;
    expect(plan.childScheduleGlobalIds).toEqual(['sched-regen']);
    expect(schedule.parentPlanGlobalId).toBe('plan-regen');
  });

  it('when a file groups the same pair via BOTH IfcRelNests and IfcRelAssignsToControl, the pair is not double-counted and IfcRelNests (Pass 4b, which runs first) wins the parentPlanGlobalId', async () => {
    const step = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('workplan both relations'),'2;1');",
      "FILE_NAME('','',(''),(''),'','','');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;',
      "#1=IFCPROJECT('p',#10,'P',$,$,$,$,$,$);",
      "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
      "#778=IFCWORKPLAN('plan-both',#10,'Work Plan',$,$,$,$,$,$,$,$,$,$,$);",
      "#794=IFCWORKSCHEDULE('sched-both',#10,'Sub Schedule',$,$,$,$,$,$,$,$,$,$,.PLANNED.);",
      "#784=IFCRELNESTS('rel-nests-both',#10,$,$,#778,(#794));",
      "#785=IFCRELASSIGNSTOCONTROL('rel-control-both',#10,$,$,(#794),$,#778);",
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');

    const store = await parseStep(step);
    const parsed = extractScheduleOnDemand(store);

    const plan = parsed.workSchedules.find(ws => ws.kind === 'WorkPlan')!;
    const schedule = parsed.workSchedules.find(ws => ws.kind === 'WorkSchedule')!;
    // Not duplicated: one entry, not two.
    expect(plan.childScheduleGlobalIds).toEqual(['sched-both']);
    expect(schedule.parentPlanGlobalId).toBe('plan-both');
  });
});
