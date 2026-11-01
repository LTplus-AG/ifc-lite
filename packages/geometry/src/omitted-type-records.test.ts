/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * F2 (#8341): the omitted-type-record count is read from the IfcAPI that ran
 * the prepass and relayed on the stream's `complete` event. An older wasm
 * (no getter, or a report without the field) must read as unknown (the key
 * absent), never as 0 and never as a crash. The wasm is mocked here; the real
 * boundary is pinned in scripts/lib/wasm-pipeline-diagnostics-contracts.mjs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => {
  const state = {
    hasGetter: true,
    /** What the IfcAPI's report holds; `buildPrePassOnce` installs `prepassReport`. */
    report: undefined as unknown,
    prepassReport: undefined as unknown,
    batchesSeen: 0,
  };
  class MockIfcAPI {
    getPipelineDiagnostics?: () => unknown;
    constructor() {
      if (state.hasGetter) this.getPipelineDiagnostics = () => state.report;
    }
    buildPrePassOnce() {
      state.report = state.prepassReport; // a prepass resets, then records
      return {
        jobs: new Uint32Array([11, 0, 3]), totalJobs: 1, unitScale: 1,
        rtcOffset: new Float64Array([0, 0, 0]), needsShift: false, buildingRotation: 0,
        voidKeys: new Uint32Array(), voidCounts: new Uint32Array(), voidValues: new Uint32Array(),
        styleIds: new Uint32Array(), styleColors: new Uint8Array(),
      };
    }
    processGeometryBatch() {
      state.batchesSeen++;
      return { length: 0, get: () => undefined, free: vi.fn() };
    }
    clearPrePassCache = vi.fn(); // preserves the report, like Rust
  }
  return { state, MockIfcAPI, init: vi.fn(async () => undefined) };
});

vi.mock('@ifc-lite/wasm', () => ({ default: wasm.init, IfcAPI: wasm.MockIfcAPI }));

import { GeometryProcessor, type StreamingGeometryEvent } from './index.js';
import {
  annotatePrepassComplete,
  omittedTypeRecordsField,
  parseOmittedTypeRecords,
  readOmittedTypeRecords,
} from './omitted-type-records.js';

async function completeOf(stream: AsyncGenerator<StreamingGeometryEvent>) {
  let complete: StreamingGeometryEvent | undefined;
  for await (const event of stream) if (event.type === 'complete') complete = event;
  return complete;
}

describe('readOmittedTypeRecords (#8341)', () => {
  it('reads the count, including a known 0', () => {
    expect(readOmittedTypeRecords({ getPipelineDiagnostics: () => ({ schemaVersion: 1, omittedTypeRecords: 2 }) })).toBe(2);
    expect(readOmittedTypeRecords({ getPipelineDiagnostics: () => ({ schemaVersion: 1, omittedTypeRecords: 0 }) })).toBe(0);
  });

  it('reports unknown, never 0, for a wasm without the getter, without a report, or without the field', () => {
    expect(readOmittedTypeRecords({})).toBeUndefined();
    expect(readOmittedTypeRecords(null)).toBeUndefined();
    expect(readOmittedTypeRecords({ getPipelineDiagnostics: () => undefined })).toBeUndefined();
    expect(readOmittedTypeRecords({ getPipelineDiagnostics: () => ({ schemaVersion: 1, refusedPrepassRecords: 1 }) }))
      .toBeUndefined();
  });

  it('rejects a malformed value and survives a throwing getter', () => {
    for (const bad of [-1, 1.5, '2', Number.NaN, null]) expect(parseOmittedTypeRecords(bad)).toBeUndefined();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readOmittedTypeRecords({ getPipelineDiagnostics: () => { throw new Error('boom'); } })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('annotates only the prepass complete event, and only with a known count', () => {
    const api = { getPipelineDiagnostics: () => ({ omittedTypeRecords: 3 }) };
    const jobs: Record<string, unknown> = { type: 'jobs' };
    const complete: Record<string, unknown> = { type: 'complete', totalJobs: 4 };
    annotatePrepassComplete(api, jobs);
    annotatePrepassComplete(api, complete);
    expect(jobs).toEqual({ type: 'jobs' });
    expect(complete).toEqual({ type: 'complete', totalJobs: 4, omittedTypeRecords: 3 });
    const older: Record<string, unknown> = { type: 'complete', totalJobs: 4 };
    annotatePrepassComplete({}, older);
    expect('omittedTypeRecords' in older).toBe(false);
    expect(omittedTypeRecordsField(undefined)).toEqual({});
    expect(omittedTypeRecordsField(0)).toEqual({ omittedTypeRecords: 0 });
  });
});

describe('GeometryProcessor main-thread prepass paths relay the count (#8341)', () => {
  beforeEach(() => {
    wasm.state.hasGetter = true;
    wasm.state.report = undefined;
    wasm.state.prepassReport = { schemaVersion: 1, batches: 0, omittedTypeRecords: 2 };
    wasm.state.batchesSeen = 0;
  });

  it('processAdaptive (<2 MB, buildPrePassOnce): complete carries the prepass instance count', async () => {
    const complete = await completeOf(new GeometryProcessor().processAdaptive(new Uint8Array([65])));
    expect(wasm.state.batchesSeen).toBe(1);
    expect(complete).toMatchObject({ type: 'complete', omittedTypeRecords: 2 });
  });

  it('processStreaming (buildPrePassOnce + batches): complete carries the count', async () => {
    const complete = await completeOf(new GeometryProcessor().processStreaming(new Uint8Array([65])));
    expect(complete).toMatchObject({ type: 'complete', omittedTypeRecords: 2 });
  });

  it('an older wasm without the getter leaves the key absent instead of reporting 0', async () => {
    wasm.state.hasGetter = false;
    const complete = await completeOf(new GeometryProcessor().processAdaptive(new Uint8Array([65])));
    expect(complete?.type).toBe('complete');
    expect(complete && 'omittedTypeRecords' in complete).toBe(false);
  });

  it('a report without the field (wasm before #8350) is unknown too', async () => {
    wasm.state.prepassReport = { schemaVersion: 1, batches: 0, refusedPrepassRecords: 1 };
    const complete = await completeOf(new GeometryProcessor().processAdaptive(new Uint8Array([65])));
    expect(complete && 'omittedTypeRecords' in complete).toBe(false);
  });
});
