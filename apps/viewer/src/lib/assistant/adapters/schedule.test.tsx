/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser, deterministicGlobalId, extractScheduleOnDemand, serializeScheduleToStep, type IfcDataStore, type ScheduleExtraction } from '@ifc-lite/parser';
import { cleanup, click, render, waitFor } from '@/test/render';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useViewerStore } from '@/store';
import { DEFAULT_OPTIONS, generateScheduleFromSpatialHierarchy } from '@/components/viewer/schedule/generate-schedule';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { cancelAssistant, useAssistant } from '../conversation';
import { architectureSample, sampleModel } from './coordination.test-support';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

interface Row { kind: string; modelId: string | null; globalId: string; expressId: number | null; name: string;
  start: string | null; finish: string | null; datesAvailable: boolean; isMilestone: boolean; parentGlobalId: string | null;
  productCount: number; productGlobalIds: string[]; productGlobalIdsSampled: boolean; provenance: string }
const rowsOf = (payload: string): Row[] => JSON.parse(payload).evidence.rows.map((row: { data: Row }) => row.data);
const summaryOf = (payload: string) => JSON.parse(payload).evidence.summary;

/** Storey tasks over the real sample's products, dated from 2026-03-02. */
async function storeySchedule(): Promise<{ store: IfcDataStore; extraction: ScheduleExtraction }> {
  const store = await architectureSample();
  const preview = generateScheduleFromSpatialHierarchy(store, { ...DEFAULT_OPTIONS, strategy: 'IfcBuildingStorey',
    startDate: '2026-03-02T08:00:00' });
  assert.ok(!preview.empty && preview.extraction.tasks.length > 0, 'the authored sample has storeys with products');
  return { store, extraction: preview.extraction };
}

/** The real sample with `extraction` written into it as IFC, parsed back: a schedule extracted from a file. */
async function sampleWithSchedule(extraction: ScheduleExtraction): Promise<IfcDataStore> {
  const text = (await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url))).toString('utf8');
  const store = await architectureSample();
  const { lines } = serializeScheduleToStep(extraction, { nextId: Math.max(...store.entityIndex.byId.keys()) + 1, ownerHistoryId: 1 });
  const end = text.lastIndexOf('ENDSEC;');
  const bytes = new TextEncoder().encode(`${text.slice(0, end)}${lines.join('\n')}\n${text.slice(end)}`);
  return new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
}

test('#6833 schedule: no extracted, generated or imported schedule is unavailable', async () => {
  const store = await architectureSample();
  useViewerStore.setState({ models: new Map([['A', sampleModel('A', store, 0)]]), activeModelId: 'A', scheduleData: null });
  const snapshot = captureEvidence('schedule');
  assert.equal(JSON.parse(snapshot.payload).sourceAvailability, 'unavailable');
  assert.equal(snapshot.totalRows, 0);
});

test('#6833 schedule: a generated schedule cites real products and says it was authored in this session', async () => {
  const { store, extraction } = await storeySchedule();
  useViewerStore.setState({ models: new Map([['A', sampleModel('A', store, 0)]]), activeModelId: 'A' });
  useViewerStore.getState().commitGeneratedSchedule(extraction, 'A');

  const snapshot = captureEvidence('schedule');
  const summary = summaryOf(snapshot.payload);
  const rows = rowsOf(snapshot.payload);
  assert.equal(snapshot.totalRows, extraction.tasks.length);
  assert.equal(summary.taskCount, extraction.tasks.length);
  assert.equal(summary.provenance.tasksAuthoredInSession, extraction.tasks.length);
  assert.equal(summary.provenance.tasksFromIfcFile, 0);
  assert.match(summary.provenance.sessionAuthoredOrigin, /not record/);
  assert.equal(summary.dateRange.start.slice(0, 10), '2026-03-02');
  const task = rows.find(row => row.productCount > 0);
  assert.ok(task);
  assert.equal(task.provenance, 'session-authored');
  assert.equal(task.expressId, null, 'a generated task has no IFC express id yet');
  assert.equal(task.modelId, 'A');
  assert.ok(task.productGlobalIds.length <= 10);
  assert.equal(task.productGlobalIdsSampled, task.productCount > 10);
  for (const globalId of task.productGlobalIds) assert.ok(store.entities.getExpressIdByGlobalId(globalId) > 0, `${globalId} is a product of the sample`);
  assert.ok(task.start && task.finish);
  assert.equal(evidenceIsCurrent(snapshot), true);

  useViewerStore.getState().updateTask(task.globalId, { name: 'Renamed storey works' });
  assert.equal(evidenceIsCurrent(snapshot), false, 'a schedule edit replaces the extraction');
});

test('#6833 schedule: the Gantt panel extracts IfcTask data from the file and its header attaches it', async () => {
  const { extraction } = await storeySchedule();
  const [first] = extraction.tasks;
  const milestone = { ...first, globalId: deterministicGlobalId('adapter-handover'), name: 'Handover', isMilestone: true, productExpressIds: [],
    productGlobalIds: [], childGlobalIds: [], parentGlobalId: undefined,
    taskTime: { scheduleStart: '2026-06-01T08:00:00', scheduleFinish: '2026-06-01T08:00:00' } };
  const undated = { ...milestone, globalId: deterministicGlobalId('adapter-snagging'), name: 'Snagging (no dates)', isMilestone: false, taskTime: undefined };
  const schedule = extraction.workSchedules[0];
  const authored: ScheduleExtraction = { ...extraction, tasks: [...extraction.tasks, milestone, undated],
    workSchedules: [{ ...schedule, taskGlobalIds: [...schedule.taskGlobalIds, milestone.globalId, undated.globalId] }] };
  const store = await sampleWithSchedule(authored);
  const model = sampleModel('A', store, 0);
  useViewerStore.setState({ models: new Map([['A', model]]), activeModelId: 'A', ifcDataStore: store, scheduleData: null });

  const ui = render(renderPanelBody('gantt', () => undefined));
  await waitFor(() => (useViewerStore.getState().scheduleData?.tasks.length ?? 0) > 0, 'the panel extracts the file schedule');
  const discuss = ui.querySelector<HTMLButtonElement>('button[aria-label="Discuss with AI"]');
  assert.ok(discuss, 'the Gantt header offers Discuss with AI');
  click(discuss);
  const snapshot = useAssistant.getState().snapshot;
  assert.ok(snapshot);
  assert.equal(snapshot.source, 'schedule');
  const summary = summaryOf(snapshot.payload);
  const rows = rowsOf(snapshot.payload);
  assert.equal(snapshot.totalRows, authored.tasks.length);
  assert.equal(summary.provenance.tasksFromIfcFile, authored.tasks.length);
  assert.equal(summary.provenance.sessionAuthoredOrigin, null);
  assert.equal(summary.milestoneCount, 1);
  assert.equal(summary.tasksWithoutDates, 1);
  assert.equal(summary.dateRange.end.slice(0, 10), '2026-06-01');
  const handover = rows.find(row => row.name === 'Handover');
  const snagging = rows.find(row => row.name === 'Snagging (no dates)');
  assert.ok(handover && snagging);
  assert.equal(handover.isMilestone, true);
  assert.equal(handover.provenance, 'ifc-file');
  assert.equal(handover.expressId, store.entities.getExpressIdByGlobalId(handover.globalId));
  assert.equal(snagging.start, null);
  assert.equal(snagging.finish, null);
  assert.equal(snagging.datesAvailable, false);
  const withProducts = rows.find(row => row.productCount > 0);
  assert.ok(withProducts?.productGlobalIds.every(globalId => store.entities.getExpressIdByGlobalId(globalId) > 0));
});

test('#6833 schedule: more tasks than the row budget keep the exact native count and stale after an edit', async () => {
  const { extraction } = await storeySchedule();
  const [template] = extraction.tasks;
  const tasks = Array.from({ length: 120 }, (_, i) => ({ ...template, globalId: deterministicGlobalId(`adapter-task-${i}`), name: `Task ${i}`,
    childGlobalIds: [], parentGlobalId: undefined, productExpressIds: [], productGlobalIds: [] }));
  const store = await sampleWithSchedule({ ...extraction, tasks, sequences: [],
    workSchedules: [{ ...extraction.workSchedules[0], taskGlobalIds: tasks.map(task => task.globalId) }] });
  useViewerStore.setState({ models: new Map([['A', sampleModel('A', store, 0)]]), activeModelId: 'A' });
  useViewerStore.getState().setScheduleData(extractScheduleOnDemand(store));

  const snapshot = captureEvidence('schedule');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(snapshot.totalRows, 120);
  assert.equal(payload.evidence.summary.taskCount, 120);
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.sampled, true);
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(snapshot), false);
});
