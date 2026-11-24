/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import {
  forwardKeyPlan,
  globalKeyPlanningField,
  globalPlanColumns,
  plannedJobs,
  WorkerGlobalPlan,
  type GeometryWorkerAddKeyPlanMessage,
  type GlobalPlanApi,
} from './global-instance-plan.js';

const g = globalThis as Record<string, unknown>;
afterEach(() => {
  delete g.__IFC_LITE_GLOBAL_INSTANCING;
});

const NONE = 0xffff_ffff;
const jobs = Uint32Array.from([10, 0, 5, 11, 5, 9, 12, 9, 14]);

describe('global instance plan messages', () => {
  it('stay off unless the flag arms them', () => {
    const columns = { mappedInstancePlan: Uint32Array.of(21), mappedInstanceCounts: Uint32Array.of(9) };
    expect(globalKeyPlanningField()).toEqual({});
    expect(globalPlanColumns(columns)).toEqual({});
    g.__IFC_LITE_GLOBAL_INSTANCING = 1;
    expect(globalKeyPlanningField()).toEqual({ globalInstancing: true });
    expect(globalPlanColumns(columns)).toEqual({ globalInstancing: true, mappedInstanceCounts: Uint32Array.of(9) });
    expect(globalPlanColumns({ ...columns, mappedInstanceCounts: Uint32Array.of(9, 1) }), 'counts must parallel the plan').toEqual({});
  });

  it('forward only planned jobs, and nothing for a chunk without plan indices', () => {
    expect(plannedJobs(jobs, Uint32Array.of(0, NONE, 3))).toEqual({ jobIds: Uint32Array.of(10, 12), planIndex: Uint32Array.of(0, 3) });
    expect(plannedJobs(jobs, Uint32Array.of(NONE, NONE, NONE))).toBeNull();
    expect(plannedJobs(jobs, undefined)).toBeNull();
    expect(plannedJobs(jobs, Uint32Array.of(0)), 'one index per job').toBeNull();
    const sent: GeometryWorkerAddKeyPlanMessage[] = [];
    const worker = { postMessage: (m: GeometryWorkerAddKeyPlanMessage) => sent.push(m) } as unknown as Worker;
    forwardKeyPlan((setup) => { setup(worker); setup(worker); }, jobs, Uint32Array.of(1, 1, NONE));
    expect(sent.map((m) => [...m.jobIds])).toEqual([[10, 11], [10, 11]]);
    expect(sent[0].jobIds).not.toBe(sent[1].jobIds);
  });
});

describe('WorkerGlobalPlan', () => {
  function api() {
    const calls: string[] = [];
    const engine: GlobalPlanApi = {
      setGlobalInstancePlan: (ids, counts) => calls.push(`plan ${[...ids]} ${[...counts]}`),
      addGlobalKeyPlan: (ids, index) => calls.push(`keys ${[...ids]} ${[...index]}`),
    };
    return { calls, engine };
  }
  const columns = { globalInstancing: true, mappedInstancePlan: Uint32Array.of(21), mappedInstanceCounts: Uint32Array.of(9) };
  const chunk: GeometryWorkerAddKeyPlanMessage = { type: 'add-key-plan', jobIds: Uint32Array.of(10), planIndex: Uint32Array.of(0) };

  it('replays the plan and every recorded chunk onto a rebuilt engine', () => {
    const plan = new WorkerGlobalPlan(), first = api(), rebuilt = api();
    plan.apply(first.engine, columns);
    plan.record(first.engine, chunk);
    expect(first.calls).toEqual(['plan 21 9', 'keys 10 0']);
    plan.apply(rebuilt.engine, columns);
    expect(rebuilt.calls).toEqual(['plan 21 9', 'keys 10 0']);
  });

  it('arms nothing without the flag on the columns or on an engine without both entry points, and forgets on clear', () => {
    const plan = new WorkerGlobalPlan(), engine = api();
    plan.record(null, chunk);
    plan.apply(engine.engine, { ...columns, globalInstancing: false });
    plan.apply({}, columns);
    plan.apply({ setGlobalInstancePlan: engine.engine.setGlobalInstancePlan }, columns);
    plan.record(engine.engine, chunk);
    expect(engine.calls, 'an engine missing an entry point is never armed, nor fed key plans').toEqual([]);
    plan.clear();
    plan.apply(engine.engine, columns);
    expect(engine.calls).toEqual(['plan 21 9']);
  });
});
