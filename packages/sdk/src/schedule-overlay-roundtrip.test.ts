/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser, extractScheduleOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createEffectiveRecordOverlay } from './index.js';

const SOURCE = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('schedule.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
  "#1=IFCTASKTIME($,$,$,.WORKTIME.,'P2D','2026-01-01T08:00:00','2026-01-03T08:00:00',$,$,$,$,$,$,$,$,$,$,$,$,$);",
  "#2=IFCTASK('task-a',$,'Original A',$,$,'A',$,$,$,.F.,$,#1,.CONSTRUCTION.);",
  "#3=IFCTASK('task-b',$,'Original B',$,$,'B',$,$,$,.F.,$,$,.CONSTRUCTION.);",
  "#4=IFCWORKSCHEDULE('schedule',$,'Main schedule',$,$,'S1',$,$,$,$,$,$,$,$);",
  "#5=IFCRELASSIGNSTOCONTROL('assignment',$,$,$,(#2,#3),$,#4);",
  'ENDSEC;', 'END-ISO-10303-21;',
].join('\n');

async function parse(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

describe('schedule effective records (#5249)', () => {
  it('matches exported and reparsed task, time and relationship edits', async () => {
    const store = await parse(SOURCE);
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);
    editor.setAttribute(2, 'Name', 'Edited A');
    editor.setPositionalAttribute(1, 4, 'P5D');
    editor.removeEntity(3);
    const task = editor.addEntity('IfcTask', [
      'task-c', null, 'New C', null, null, 'C', null, null, null, '.F.', null, '#1', '.CONSTRUCTION.',
    ]);
    editor.setPositionalAttribute(5, 4, [`#2`, `#${task.expressId}`]);
    const relation = editor.addEntity('IfcRelSequence', [
      'sequence', null, null, null, '#2', `#${task.expressId}`, '#1', '.FINISH_START.', null,
    ]);

    const pending = extractScheduleOnDemand(store, {
      overlay: createEffectiveRecordOverlay(view, store),
    });
    expect(pending.tasks.map(t => t.name)).toEqual(['Edited A', 'New C']);
    expect(pending.tasks[0].taskTime?.scheduleDuration).toBe('P5D');
    expect(pending.workSchedules[0].taskGlobalIds).toEqual(['task-a', 'task-c']);
    expect(pending.sequences.map(s => s.globalId)).toEqual(['sequence']);
    expect(relation.expressId).toBeGreaterThan(task.expressId);

    const exported = new StepExporter(store, view).export({
      schema: store.schemaVersion, applyMutations: true,
    });
    const reparsed = extractScheduleOnDemand(await parse(new TextDecoder().decode(exported.content)));
    expect(pending).toEqual(reparsed);
  });

  it('moves a retyped source task out of the schedule entity set', async () => {
    const store = await parse(SOURCE);
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);
    editor.setEntityType(3, 'IfcWall');
    const pending = extractScheduleOnDemand(store, { overlay: createEffectiveRecordOverlay(view, store) });
    expect(pending.tasks.map(t => t.globalId)).toEqual(['task-a']);
    expect(pending.workSchedules[0].taskGlobalIds).toEqual(['task-a']);
  });
});
