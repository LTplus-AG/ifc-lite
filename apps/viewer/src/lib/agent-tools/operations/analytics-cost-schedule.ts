/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { buildCostTree, classifyCostModel, getAssignedTargets, getOwningSchedules } from '@/lib/cost/cost-tree';
import { buildCostCsvReport } from '@/lib/analysis/export-csv';
import { selectCostTargets } from '@/lib/cost/select-targets';
import { operation, viewerOperation, emptySchema } from './contract';
import { metadata, artifactSchema, checkpoint } from './analytics-common';
import { invalidInput, unavailable } from './refusals';
const cost = (id: string, description: string, output: Record<string, unknown>) => metadata(id, 'cost', description, ['read'], output);
function timeline() {
  const s = useViewerStore.getState();
  return { sourceModelId: s.scheduleSourceModelId, activeWorkScheduleId: s.activeWorkScheduleId, range: s.scheduleRange,
    timeScale: s.ganttTimeScale, time: s.playbackTime, speed: s.playbackSpeed, loop: s.playbackLoop,
    playing: s.playbackIsPlaying, animationEnabled: s.animationEnabled, animationSettings: s.animationSettings,
    selectedTasks: [...s.selectedTaskGlobalIds], edited: s.scheduleIsEdited };
}
const timelineSchema = { type: 'object', properties: {
  sourceModelId: { type: ['string', 'null'] }, activeWorkScheduleId: { type: 'string' }, range: { type: ['object', 'null'] }, timeScale: { type: 'string' }, time: { type: 'number' }, speed: { type: 'number' }, loop: { type: 'boolean' }, playing: { type: 'boolean' }, animationEnabled: { type: 'boolean' }, animationSettings: { type: 'object' }, selectedTasks: { type: 'array', items: { type: 'string' } }, edited: { type: 'boolean' },
}, required: ['sourceModelId', 'activeWorkScheduleId', 'range', 'timeScale', 'time', 'speed', 'loop', 'playing', 'animationEnabled', 'animationSettings', 'selectedTasks', 'edited'], additionalProperties: false };
export const analyticsCostScheduleOperations = [
  operation(cost('cost.graph', 'Read the complete effective cost relationship graph and native Cost-panel tree/diagnostics.', {
    type: 'object', properties: { graph: { type: 'object' }, tree: { type: 'object' }, diagnostics: { type: 'object' } }, required: ['graph', 'tree', 'diagnostics'], additionalProperties: false,
  }), emptySchema, (_, c) => { const graph = c.model.bim.cost.data(c.model.id); return { graph, tree: buildCostTree(graph), diagnostics: classifyCostModel(graph) }; }),
  operation<{ express_id: number; target: 'item' | 'value'; precision: number }>(cost('cost.evaluate', 'Evaluate an IfcCostItem or IfcCostValue through the native effective model backend; unresolved diagnostics are returned intact.', {
    type: 'object', properties: { evaluation: { type: 'object' }, assignments: { type: 'array' }, schedules: { type: 'array' } }, required: ['evaluation', 'assignments', 'schedules'], additionalProperties: false,
  }), {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 }, target: { type: 'string', enum: ['item', 'value'] }, precision: { type: 'integer', minimum: 1, maximum: 10000 } }, required: ['express_id', 'target', 'precision'], additionalProperties: false,
  } satisfies JSONSchemaType<{ express_id: number; target: 'item' | 'value'; precision: number }>, (i, c) => {
    const graph = c.model.bim.cost.data(c.model.id);
    const exists = i.target === 'item' ? graph.CostItems.some(row => row.ref.expressId === i.express_id) : graph.CostValues.some(row => row.ref.expressId === i.express_id);
    if (!exists) throw invalidInput('unknown-target', 'The requested cost record does not exist in this model.');
    const ref = { modelId: c.model.id, expressId: i.express_id };
    const evaluation = i.target === 'item' ? c.model.bim.cost.evaluateItem(ref, { Precision: i.precision }) : c.model.bim.cost.evaluateValue(ref, { Precision: i.precision });
    return { evaluation, assignments: i.target === 'item' ? getAssignedTargets(graph, ref) : [], schedules: i.target === 'item' ? getOwningSchedules(graph, ref) : [] };
  }),
  operation(metadata('cost.exportCsv', 'cost', 'Await the native Cost-panel CSV writer and effective item evaluations for the explicitly targeted model, including unresolved diagnostics.', ['read', 'artifact'], artifactSchema), emptySchema, async (_, c) => {
    const graph = c.model.bim.cost.data(c.model.id);
    const report = buildCostCsvReport([{ modelName: c.model.name, graph }], ref => c.model.bim.cost.evaluateItem(ref));
    if (!report) throw unavailable('The target model has no native cost items to export.'); checkpoint(c);
    return c.artifacts.create({ filename: report.filename, mimeType: 'text/csv;charset=utf-8', data: report.content });
  }),
  operation<{ express_id: number }>(metadata('cost.selectAssigned', 'cost', 'Select all native assigned cost-item targets through the same two-channel Cost-panel handler. Camera framing is dispatched.', ['selection', 'view'], {
    type: 'object', properties: { refs: { type: 'array' } }, required: ['refs'], additionalProperties: false,
  }), {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 } }, required: ['express_id'], additionalProperties: false,
  } satisfies JSONSchemaType<{ express_id: number }>, (i, c) => {
    const graph = c.model.bim.cost.data(c.model.id);
    if (!graph.CostItems.some(row => row.ref.expressId === i.express_id)) throw invalidInput('unknown-target', 'Unknown cost item in this model.');
    const refs = getAssignedTargets(graph, { modelId: c.model.id, expressId: i.express_id });
    checkpoint(c); c.commit(() => selectCostTargets(refs)); return { refs };
  }),
  operation(metadata('cost.exportGraph', 'cost', 'Export the native effective cost graph and diagnostics as a real JSON artifact.', ['read', 'artifact'], artifactSchema), emptySchema, async (_, c) => {
    const data = c.model.bim.cost.data(c.model.id); checkpoint(c);
    return c.artifacts.create({ filename: 'cost-graph.json', mimeType: 'application/json', data: JSON.stringify(data, null, 2) });
  }),
  operation(metadata('schedule.timeline', 'gantt', 'Read effective native Gantt timeline/playback/animation settings, source attribution and pending-edit state.', ['read'], timelineSchema), emptySchema, timeline),
  operation<{ work_schedule_id: string; scale: 'hour' | 'day' | 'week' | 'month' | 'year'; time: number; speed: number; loop: boolean; animation: boolean }>(metadata('schedule.configureTimeline', 'gantt', 'Set native work-schedule filter, time scale, bounded seek, speed, loop and animation settings. This changes timeline state; it does not claim a completed playback.', ['configuration', 'view'], timelineSchema), {
    type: 'object', properties: { work_schedule_id: { type: 'string', maxLength: 200 }, scale: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year'] }, time: { type: 'number' }, speed: { type: 'number', exclusiveMinimum: 0, maximum: 3650 }, loop: { type: 'boolean' }, animation: { type: 'boolean' } }, required: ['work_schedule_id', 'scale', 'time', 'speed', 'loop', 'animation'], additionalProperties: false,
  } satisfies JSONSchemaType<{ work_schedule_id: string; scale: 'hour' | 'day' | 'week' | 'month' | 'year'; time: number; speed: number; loop: boolean; animation: boolean }>, (i, c) => {
    const s = useViewerStore.getState();
    if (!s.scheduleData || !s.scheduleRange) throw unavailable('No native schedule timeline is loaded.');
    if (s.scheduleSourceModelId !== c.model.id) throw invalidInput('wrong-target', 'The timeline belongs to a different or unattributed model.');
    if (!(i.time >= s.scheduleRange.start && i.time <= s.scheduleRange.end)) throw invalidInput('invalid-value', 'Seek time lies outside the schedule range.');
    if (i.work_schedule_id && !s.scheduleData.workSchedules.some(row => row.globalId === i.work_schedule_id)) throw invalidInput('unknown-target', 'Unknown work schedule.');
    checkpoint(c); c.commit(() => { s.setActiveWorkScheduleId(i.work_schedule_id); s.setGanttTimeScale(i.scale); s.seekSchedule(i.time); s.setPlaybackSpeed(i.speed); s.setPlaybackLoop(i.loop); s.setAnimationEnabled(i.animation); }); return timeline();
  }),
  viewerOperation(metadata('schedule.pause', 'gantt', 'Pause native playback and read its final timeline state.', ['view'], timelineSchema), emptySchema, (_, c) => { checkpoint(c); c.commit(() => useViewerStore.getState().pauseSchedule()); return timeline(); }),
];
