/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #9296: one isolated process per size; parent enforces the wall-clock deadline.
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { writeFileSync, renameSync } from 'node:fs';
import { loadavg, hostname, cpus } from 'node:os';
import { OPERATIONS, summarize } from './modelling-session.mjs';

const [checkpoint, targetText, budgetText, samplesText] = process.argv.slice(2);
const target = Number(targetText), budgetMs = Number(budgetText), samples = Number(samplesText);
const start = performance.now();
const state = {
  target, reached: 0, after: 0, phase: 'load', operations: {}, samples: {},
  totalMs: 0, peakHeapBytes: 0, peakRssBytes: 0,
  host: { hostname: hostname(), node: process.version, cpu: cpus()[0]?.model,
    loadStart: loadavg(), diagnostic: true },
};
function save() {
  const memory = process.memoryUsage();
  state.peakHeapBytes = Math.max(state.peakHeapBytes, memory.heapUsed);
  state.peakRssBytes = Math.max(state.peakRssBytes, memory.rss);
  state.totalMs = performance.now() - start;
  state.host.loadEnd = loadavg();
  writeFileSync(`${checkpoint}.tmp`, JSON.stringify(state));
  renameSync(`${checkpoint}.tmp`, checkpoint);
}
function expired() { return performance.now() - start >= budgetMs; }
function time(name, fn) {
  if (expired()) throw new Error(`Size budget exhausted before ${name}`);
  state.phase = name;
  save();
  const before = state.after, t = performance.now();
  const value = fn();
  const ms = performance.now() - t;
  (state.samples[name] ??= []).push({ ms, elementsBefore: before, elementsAfter: state.after });
  state.operations[name] = summarize(state.samples[name].map(s => s.ms));
  save();
  return value;
}
save();
try {
  const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
  const { IfcCreator } = await import(require.resolve('@ifc-lite/create'));
  const { createHeadlessContext } = await import('../../packages/cli/dist/loader.js');
  const creator = new IfcCreator({ Name: 'Session scale #9296' });
  creator.addIfcBuildingStorey({ Name: 'L1', Elevation: 0 });
  const content = creator.toIfc().content;
  const { bim } = await createHeadlessContext({ bytes: new TextEncoder().encode(content), name: 'session.ifc', label: 'session.ifc' });
  const M = bim.model.activeId();
  const levels = [bim.store.listStoreyLevels(M)[0].expressId];
  for (let i = 1; i < 10; i++) levels.push(bim.store.addStorey(M, { Name: `L${i + 1}`, Elevation: i * 3 }).expressId);
  // Count authored architectural elements, excluding storeys and implementation
  // records (placements, representations, opening voids). No bulk overlay bypass.
  function column(i, level = levels[i % 10]) {
    const value = bim.store.addColumn(M, level, { Position: [i % 100, Math.floor(i / 100), 0], Width: 0.3, Depth: 0.3, Height: 3 });
    state.after++;
    return value.expressId;
  }
  function wall(x, perpendicular = false) {
    const value = bim.store.addWall(M, levels[0], { Start: [x, 0, 0], End: perpendicular ? [x, 10, 0] : [x + 10, 0, 0], Thickness: 0.3, Height: 3 });
    state.after++;
    return value.expressId;
  }
  const floor = [];
  for (let i = 0; i < 40; i++) floor.push(column(i, levels[0]));
  for (let i = 0; i < 9; i++) floor.push(wall(100 + i * 20));
  floor.push(bim.store.addSlab(M, levels[0], { Position: [0, 0, 0], Width: 36, Depth: 36, Thickness: 0.3 }).expressId);
  state.after++;
  const host = wall(-20);
  state.phase = 'fill';
  save();
  // Leave one quarter of the size budget for diagnostic samples at the cutoff.
  while (state.after < target && performance.now() - start < budgetMs * 0.75) {
    column(state.after);
    if (state.after % 25 === 0) save();
  }
  state.reached = state.after;
  save();
  for (let i = 0; i < samples; i++) {
    time('addWall', () => wall(1000 + i * 20));
    time('addColumn', () => column(state.after));
    time('addSlab', () => {
      const r = bim.store.addSlab(M, levels[0], { Position: [0, 0, 0], Width: 10, Depth: 10, Thickness: 0.3 });
      state.after++; return r;
    });
    time('addHostedWindow', () => {
      const r = bim.store.addHostedWindow(M, host, { Offset: 1 + i * 1.5, Sill: 0.9, Width: 1, Height: 1.2 });
      state.after++; return r;
    });
    if (expired()) throw new Error('Size budget exhausted before join setup');
    const a = wall(2000 + i * 20), b = wall(2000 + i * 20, true);
    time('joinWalls', () => bim.store.joinWalls(M, a, b));
    time('copyElements', () => {
      const r = bim.store.copyElements(M, floor, [{ targetStoreyId: levels[1] }]);
      state.after += 50; return r;
    });
    const edit = { kind: 'floorHeight', storeyId: levels[0], Height: i % 2 ? 3 : 3.2 };
    const plan = time('planStoreyEdit', () => bim.store.planStoreyEdit(M, edit));
    time('editStorey', () => bim.store.editStorey(M, edit, plan));
    time('exportIfc', () => {
      const data = bim.export.ifc(undefined, { schema: 'IFC4' });
      state.exportBytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    });
  }
  state.complete = state.reached === target && OPERATIONS.every(op => state.operations[op]?.count === samples);
  if (!state.complete) state.reason = `Fill allowance exhausted at ${state.reached}/${target} elements`;
} catch (error) {
  state.reason = error.message ?? String(error);
  state.complete = false;
} finally {
  state.phase = 'done';
  save();
}
