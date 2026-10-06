/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Field telemetry for every journey (#6961): what `ifc_model_loaded` and the
 * three sampled events carry, read the way PostHog will receive them (through
 * `scrubEvent`, so a property the privacy guard would delete fails here).
 *
 * The modules under test are new in #6961, so each is asserted to exist and
 * then imported dynamically: reverting the change turns these tests red by
 * assertion rather than by a module-not-found load error.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLoadTracer, type LoadTrace } from '@ifc-lite/load-trace';
import { posthog } from '../analytics.js';
import { scrubEvent } from '../analytics-scrub.js';
import { memoryAccounting } from './memoryAccounting.js';
import { loadTracer } from './loadTrace.js';
import { recordModelLoadedSnapshot } from '../../utils/loadTelemetry.js';

function moduleExists(name: string): boolean {
  return existsSync(fileURLToPath(new URL(`./${name}.ts`, import.meta.url)));
}

type FieldModule = typeof import('./fieldTelemetry.js');
let loaded: FieldModule | null = null;

/** Per test, so a reverted change fails each test on this assertion, not at file load. */
async function loadField(): Promise<FieldModule> {
  assert.ok(moduleExists('fieldTelemetry'), 'the #6961 field telemetry module exists');
  loaded ??= await import('./fieldTelemetry.js');
  return loaded;
}

type Props = Record<string, unknown>;
let events: Array<{ event: string; props: Props }> = [];
const realCapture = posthog.capture;

/** What PostHog would store: the capture after the privacy scrub. */
function received(name: string): Props[] {
  return events
    .filter((e) => e.event === name)
    .map((e) => scrubEvent({ event: e.event, properties: { ...e.props } })?.properties ?? {});
}

beforeEach(() => {
  events = [];
  posthog.capture = ((event: string, props?: Props) => {
    events.push({ event, props: props ?? {} });
    return undefined;
  }) as typeof posthog.capture;
  memoryAccounting.reset();
  loaded?.resetLongFrameLogForTests();
  loaded?.resetFieldEventsForTests(() => 0);
});

afterEach(() => {
  posthog.capture = realCapture;
  loaded?.resetLongFrameLogForTests();
  loaded?.resetFieldEventsForTests(); // also clears the viewer_boot deadline timer
});

interface FakeEntry { startTime: number; duration: number; blockingDuration?: number }
function fakeObserver(supported: string[], entries: FakeEntry[]) {
  return class {
    static readonly supportedEntryTypes = supported;
    observe(): void {}
    takeRecords(): FakeEntry[] { return entries.splice(0); }
    disconnect(): void {}
  };
}

describe('production loads keep their milestones (#6961)', () => {
  it('the tracer is off, yet a load records first milestones and the attributes every path sets', async () => {
    const field = await loadField();
    assert.equal(loadTracer.enabled, false);
    const trace = loadTracer.startLoad('m', { journey: 'J1', modelKind: 'primary' }, 1_000);
    assert.equal(trace.milestone('geometry.firstVisible', 120), 120);
    trace.milestone('geometry.firstVisible', 999); // first call wins
    trace.setAttrs({ workerCount: 4 }); // geometry-parallel sets this mid-load
    trace.finish({ loadPath: 'wasm', cacheTier: 'source' });
    trace.finish({ loadPath: 'late' }); // like the recording trace, the first finish wins
    const props = field.fieldLoadProps(trace, { total_elapsed_ms: 800 }, 1_800);
    assert.equal(props.first_visible_geometry_ms, 120);
    assert.equal(props.journey, 'J1');
    assert.equal(props.worker_count, 4);
    assert.equal(props.cache_tier, 'source');
  });
});

describe('fieldLoadProps: ifc_model_loaded on every path', () => {
  function streamedLoad(trace: LoadTrace): void {
    trace.milestone('parser.spatialReady', 300);
    trace.milestone('parser.complete', 900);
    trace.milestone('geometry.firstVisible', 450);
    trace.milestone('geometry.streamComplete', 1_200);
    trace.finish({ loadPath: 'wasm', cacheTier: 'mesh-only' });
  }

  it('the streaming path: the four milestones off the trace, and the row says it streamed', async () => {
    const field = await loadField();
    const trace = loadTracer.startLoad('m', { journey: 'J1' }, 0);
    streamedLoad(trace);
    const props = field.fieldLoadProps(trace, { load_path: 'wasm', total_elapsed_ms: 1_400 }, 1_400);
    assert.deepEqual(
      [props.first_visible_geometry_ms, props.spatial_ready_ms, props.metadata_complete_ms, props.stream_complete_ms, props.milestone_source],
      [450, 300, 900, 1_200, 'trace'],
    );
    assert.equal(props.perf_flags, 'default');
  });

  it('the recording trace (?perfTrace=1) reports the same milestones from its span tree', async () => {
    const field = await loadField();
    const tracer = createLoadTracer({ enabled: true, sink: null, counters: null });
    const trace = tracer.startLoad('m', { journey: 'J1' }, 0);
    streamedLoad(trace);
    const props = field.fieldLoadProps(trace, { total_elapsed_ms: 1_400 }, 1_400);
    assert.deepEqual(
      [props.first_visible_geometry_ms, props.spatial_ready_ms, props.metadata_complete_ms, props.stream_complete_ms, props.cache_tier],
      [450, 300, 900, 1_200, 'mesh-only'],
    );
  });

  it('the cache path: properties and spatial tree are ready when the store is restored', async () => {
    const field = await loadField();
    const trace = loadTracer.startLoad('m', { journey: 'J1' }, 0);
    trace.milestone('geometry.firstVisible', 80);
    trace.milestone('geometry.streamComplete', 200);
    trace.milestone('cache.storeReady', 230);
    trace.finish({ journey: 'J2', loadPath: 'cache', cacheTier: 'source' });
    const props = field.fieldLoadProps(trace, { load_path: 'cache', total_elapsed_ms: 260 }, 260);
    assert.equal(props.journey, 'J2');
    assert.equal(props.spatial_ready_ms, 230);
    assert.equal(props.metadata_complete_ms, 230);
    assert.equal(props.first_visible_geometry_ms, 80);
    assert.equal(props.milestone_source, 'trace');
    assert.ok(!('worker_transfer_bytes' in props), 'no worker carried geometry: not measured, not 0');
  });

  it('a single-step path: every milestone is the commit, stated as such', async () => {
    const field = await loadField();
    const trace = loadTracer.startLoad('m', { journey: 'J4' }, 0);
    const props = field.fieldLoadProps(trace, { load_path: 'server', total_elapsed_ms: 640 }, 640);
    assert.deepEqual(
      [props.first_visible_geometry_ms, props.spatial_ready_ms, props.metadata_complete_ms, props.stream_complete_ms, props.milestone_source],
      [640, 640, 640, 640, 'commit'],
    );
  });

  it('reports the bytes workers handed the main thread from the always-on memory accounting', async () => {
    const field = await loadField();
    memoryAccounting.addGeometryBytes(4_000);
    memoryAccounting.recordPhase({ phase: 'parser-transport', transportBytes: 500 });
    memoryAccounting.recordPhase({ phase: 'geometry-complete' });
    const props = field.fieldLoadProps(loadTracer.startLoad('m', {}, 0), { total_elapsed_ms: 1 }, 1);
    assert.equal(props.worker_transfer_bytes, 4_500);
  });

  it('a pool that ran but moved no geometry reports 0 bytes, not "not measured"', async () => {
    const field = await loadField();
    const trace = loadTracer.startLoad('m', {}, 0);
    trace.setAttrs({ workerCount: 3 });
    const props = field.fieldLoadProps(trace, { total_elapsed_ms: 1 }, 1);
    assert.equal(props.worker_transfer_bytes, 0);
  });

  it('main-thread health over the load window only, from long animation frames', async () => {
    const field = await loadField();
    const entries: FakeEntry[] = [
      { startTime: 50, duration: 400, blockingDuration: 350 }, // before the load: not this load's
      { startTime: 1_100, duration: 120, blockingDuration: 70 },
      { startTime: 1_500, duration: 260, blockingDuration: 210 },
      { startTime: 2_600, duration: 900, blockingDuration: 850 }, // after the capture
    ];
    field.startLongFrameLog(fakeObserver(['long-animation-frame', 'longtask'], entries));
    const props = field.fieldLoadProps(loadTracer.startLoad('m', {}, 1_000), { total_elapsed_ms: 1_500 }, 2_500);
    assert.equal(props.main_thread_blocked_ms, 280);
    assert.equal(props.longest_long_frame_ms, 260);
    assert.equal(props.long_frame_count, 2);
    assert.equal(props.long_frame_source, 'loaf');
  });

  it('an engine without LoAF or longtask reports nothing, not a healthy zero', async () => {
    const field = await loadField();
    field.startLongFrameLog(fakeObserver([], []));
    const props = field.fieldLoadProps(loadTracer.startLoad('m', {}, 0), { total_elapsed_ms: 10 }, 10);
    for (const key of ['main_thread_blocked_ms', 'longest_long_frame_ms', 'long_frame_count', 'long_frame_source']) {
      assert.ok(!(key in props), `${key} must be absent`);
    }
  });

  it('every new property survives the privacy scrub', async () => {
    const field = await loadField();
    field.startLongFrameLog(fakeObserver(['longtask'], [{ startTime: 10, duration: 90 }]));
    memoryAccounting.addGeometryBytes(10);
    memoryAccounting.recordPhase({ phase: 'geometry-complete' });
    const trace = loadTracer.startLoad('m', { journey: 'J1' }, 0);
    trace.setAttrs({ workerCount: 2 });
    trace.finish({ loadPath: 'wasm', cacheTier: 'source' });
    const props = field.fieldLoadProps(trace, { load_path: 'wasm', total_elapsed_ms: 100 }, 100);
    const kept = scrubEvent({ event: 'ifc_model_loaded', properties: { ...props } })?.properties ?? {};
    assert.deepEqual(Object.keys(kept).sort(), Object.keys(props).sort());
    assert.equal(kept.long_frame_source, 'longtask');
  });
});

describe('perfFlagArm: one groupable arm string', () => {
  it('is `default` with every flag at its default, else sorted id=value pairs', async () => {
    const field = await loadField();
    assert.equal(field.perfFlagArm({}), 'default');
    assert.equal(field.perfFlagArm({ quantized: 'false', geomWorkers: '2' }), 'geomWorkers=2,quantized=false');
  });
});

describe('ifc_inspect: sampled click -> properties panel populated', () => {
  const paint = globalThis.requestAnimationFrame;
  afterEach(() => { globalThis.requestAnimationFrame = paint; });

  it('times a sampled click to the panel paint for the entity that click selected', async () => {
    const field = await loadField();
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
    recordModelLoadedSnapshot({ fileSizeMB: 12.345, meshCount: 40 });
    const clickAt = performance.now() - 30;
    field.noteInspectClick(clickAt);
    field.noteInspectSelection(7);
    field.noteInspectPopulated(7);
    const [sent] = received('ifc_inspect');
    assert.ok(sent, 'one ifc_inspect');
    assert.ok(Number(sent.inspect_ms) >= 30);
    assert.equal(sent.journey, 'J5');
    assert.equal(sent.file_size_mb, 12.35);
    assert.equal(sent.perf_flags, 'default');
    assert.equal(typeof sent.was_hidden, 'boolean');
  });

  it('the panel showing another entity ends the measurement, so a later re-selection is not timed from the click', async () => {
    const field = await loadField();
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
    field.noteInspectClick(performance.now());
    field.noteInspectSelection(7);
    field.noteInspectPopulated(8); // the panel moved on before showing 7
    field.noteInspectPopulated(7); // e.g. a related-entity link back to 7, with no click
    assert.equal(received('ifc_inspect').length, 0);
  });

  it('an unsampled click, a miss, and the per-session cap send nothing', async () => {
    const field = await loadField();
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
    field.resetFieldEventsForTests(() => 0.5); // above the 10% rate
    field.noteInspectClick(performance.now());
    field.noteInspectSelection(1);
    field.noteInspectPopulated(1);
    field.resetFieldEventsForTests(() => 0);
    field.noteInspectClick(performance.now());
    field.noteInspectSelection(null);
    field.noteInspectPopulated(1);
    assert.equal(received('ifc_inspect').length, 0);
    for (let i = 0; i < field.INSPECT_MAX_PER_SESSION + 5; i++) {
      field.noteInspectClick(performance.now());
      field.noteInspectSelection(i);
      field.noteInspectPopulated(i);
    }
    assert.equal(received('ifc_inspect').length, field.INSPECT_MAX_PER_SESSION);
  });
});

describe('ifc_navigate: interaction frame p95, once per session', () => {
  it('drops the first frame of each interaction and idle frames, then sends once', async () => {
    const field = await loadField();
    field.noteNavigateFrame(16, false); // idle
    field.noteNavigateFrame(5_000, true); // first interaction frame: the idle gap before it
    for (let i = 0; i < field.NAVIGATE_FRAMES - 1; i++) field.noteNavigateFrame(i < 6 ? 50 : 10, true);
    field.noteNavigateFrame(16, false);
    field.noteNavigateFrame(16, true); // first frame of the next interaction
    assert.equal(received('ifc_navigate').length, 0);
    field.noteNavigateFrame(40, true);
    const sent = received('ifc_navigate');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].journey, 'J6');
    assert.equal(sent[0].frame_count, field.NAVIGATE_FRAMES);
    assert.equal(sent[0].frame_p50_ms, 10);
    assert.equal(sent[0].frame_p95_ms, 40);
    assert.equal(sent[0].frame_max_ms, 50);
    for (let i = 0; i < 500; i++) field.noteNavigateFrame(10, true);
    assert.equal(received('ifc_navigate').length, 1, 'once per session');
  });
});

describe('viewer_boot: drop target interactive and engine compiled', () => {
  it('sends once both are known, with the compile duration', async () => {
    const field = await loadField();
    field.noteDropTargetInteractive(812.4);
    assert.equal(received('viewer_boot').length, 0);
    field.noteEngineCompiled(1_000, 1_900, true);
    const [sent] = received('viewer_boot');
    assert.equal(sent.journey, 'J0');
    assert.equal(sent.drop_target_ms, 812);
    assert.equal(sent.engine_wasm_compiled_ms, 1_900);
    assert.equal(sent.engine_wasm_compile_ms, 900);
    assert.equal(sent.engine_wasm_compiled, true);
    field.noteDropTargetInteractive(5);
    assert.equal(received('viewer_boot').length, 1, 'once per page load');
  });

  it('a load that joined the compile, or started before the drop target, is not timed as boot', async () => {
    const field = await loadField();
    field.noteLoadStarted(1_200);
    field.noteDropTargetInteractive(1_500); // the viewer opened straight into a model
    field.noteEngineCompiled(1_000, 1_900, true);
    // Only the compile is known; the event waits for its deadline.
    assert.equal(received('viewer_boot').length, 0);
    field.flushViewerBootForTests();
    const [sent] = received('viewer_boot');
    assert.ok(!('drop_target_ms' in sent), 'a drop target after a load started is not a boot time');
    assert.equal(sent.engine_wasm_compiled_ms, 1_900);
    assert.ok(!('engine_wasm_compile_ms' in sent), 'the prewarm measured the tail of the load\'s compile');
  });
});
