/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Device-loss context enrichment (issue #2624).
 *
 * The #2624 field report - "GPU device lost (unknown): A valid external
 * Instance reference no longer exists." - was untriageable because the capture
 * carried only the reason and Dawn's message. `buildDeviceLossContext` is the
 * enrichment that makes the next one diagnosable; these tests pin the four
 * properties it must hold:
 *
 *  - the chosen key names SURVIVE the real privacy scrubber (`scrubEvent`
 *    deletes keys containing `model` / `name` / `description` / `message` as
 *    `_`-delimited words, and a test that stubs `captureException` sits ABOVE
 *    the scrubber - the exact trap device-loss-report.test.ts documents);
 *  - a hostile or half-torn-down renderer costs individual fields, never the
 *    base report;
 *  - the wiring delivers the context AT LOSS TIME through
 *    `subscribeViewportHealth`;
 *  - the enrichment spread can never shadow the base identity fields.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { posthog } from '@/lib/analytics';
import { scrubEvent } from '@/lib/analytics-scrub.js';
import { useViewerStore } from '@/store';
import {
  recordModelLoadedSnapshot,
  resetModelLoadedSnapshotForTests,
} from '@/utils/loadTelemetry.js';
import {
  buildDeviceLossContext,
  type DeviceLossContextSource,
} from './device-loss-context.js';
import {
  reportDeviceLost,
  reportPersistentRenderDegradation,
  resetDeviceLossReportForTests,
  subscribeViewportHealth,
  type ViewportHealthSource,
} from './device-loss-report.js';

/** Verbatim Dawn wording from the #2624 PostHog report. */
const DAWN_LOST = 'A valid external Instance reference no longer exists.';

interface Captured { err: unknown; props: Record<string, unknown> | undefined }

let captures: Captured[] = [];
const realWarn = console.warn;
const realCapture = posthog.captureException;
const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

function restoreDocument(): void {
  if (savedDocument) {
    Object.defineProperty(globalThis, 'document', savedDocument);
  } else {
    delete (globalThis as { document?: unknown }).document;
  }
}

function stubDocument(visibilityState: string): void {
  Object.defineProperty(globalThis, 'document', {
    value: { visibilityState },
    configurable: true,
  });
}

beforeEach(() => {
  resetDeviceLossReportForTests();
  resetModelLoadedSnapshotForTests();
  captures = [];
  console.warn = () => { /* keep the loss breadcrumbs out of test output */ };
  posthog.captureException = ((err: unknown, props?: Record<string, unknown>) => {
    captures.push({ err, props });
  }) as typeof posthog.captureException;
});

afterEach(() => {
  console.warn = realWarn;
  posthog.captureException = realCapture;
  restoreDocument();
});

/** A renderer slice where every context accessor works. */
function makeFullSource(): DeviceLossContextSource {
  return {
    getAdapterInfo: () => ({ vendor: 'testvendor', architecture: 'testarch' }),
    getFrameStats: () => ({ timestamp: performance.now() - 250 }),
    getScene: () => ({ getResidentGpuBytes: () => ({ total: 512 * 1024 * 1024 }) }),
    getCanvas: () => ({ width: 1920, height: 1080 }),
  };
}

describe('buildDeviceLossContext field content', () => {
  it('reads GPU identity, resident bytes, surface size and the last-load snapshot', () => {
    recordModelLoadedSnapshot({ fileSizeMB: 123.456, totalTriangles: 4_200_000, meshCount: 51_000 });
    const context = buildDeviceLossContext(makeFullSource());

    assert.equal(context.gpu_vendor, 'testvendor');
    assert.equal(context.gpu_architecture, 'testarch');
    assert.equal(context.gpu_resident_mb, 512, '512 MiB of resident buffers reads as 512');
    assert.equal(context.canvas_width, 1920);
    assert.equal(context.canvas_height, 1080);
    assert.equal(context.last_load_file_size_mb, 123.46, 'rounded to 2 decimals like file_size_mb');
    assert.equal(context.last_load_total_triangles, 4_200_000);
    assert.equal(context.last_load_mesh_count, 51_000);
    assert.equal(typeof context.ms_since_page_load, 'number');
  });

  it('omits the last-load fields when no load has completed - absent, not null', () => {
    // PostHog treats absent and explicit-null differently in IS NOT NULL
    // filters; "no model was loaded" must stay distinguishable.
    const context = buildDeviceLossContext(makeFullSource());
    assert.ok(!('last_load_file_size_mb' in context));
    assert.ok(!('last_load_total_triangles' in context));
    assert.ok(!('last_load_mesh_count' in context));
  });

  it('reports the load-time fidelity config from the store', () => {
    const prior = {
      geometryMode: useViewerStore.getState().geometryMode,
      geomTierOverride: useViewerStore.getState().geomTierOverride,
    };
    try {
      useViewerStore.setState({ geometryMode: 'exact', geomTierOverride: 'low' });
      const context = buildDeviceLossContext(makeFullSource());
      assert.equal(context.geometry_mode, 'exact');
      assert.equal(context.geom_tier_override, 'low');
    } finally {
      useViewerStore.setState(prior);
    }
  });
});

describe('context keys survive the REAL privacy scrubber (#2624)', () => {
  it('every enrichment field reaches the wire with its value intact', () => {
    // The trap this pins: `scrubEvent` (before_send) DELETES any property
    // whose key contains a sensitive word (`model`, `name`, `description`,
    // `message`, ...) as a `_`-delimited word. A stubbed captureException sits
    // ABOVE the scrubber, so only pushing the captured properties through the
    // real `scrubEvent` can catch a key renamed into that word list - which
    // would ship exactly the blind telemetry #2624 is about.
    stubDocument('hidden');
    recordModelLoadedSnapshot({ fileSizeMB: 88.2, totalTriangles: 1_000_000, meshCount: 20_000 });
    const context = buildDeviceLossContext(makeFullSource());
    reportDeviceLost({ message: DAWN_LOST, reason: 'unknown' }, context);

    const sent = scrubEvent({
      event: '$exception',
      properties: { ...captures[0].props },
    });
    assert.ok(sent, 'the enriched loss event must not be dropped as third-party noise');
    const props = sent.properties ?? {};
    assert.equal(props.gpu_vendor, 'testvendor', 'gpu_vendor must survive before_send');
    assert.equal(props.gpu_resident_mb, 512, 'gpu_resident_mb must survive before_send');
    assert.equal(props.last_load_total_triangles, 1_000_000, 'last_load_total_triangles must survive');
    assert.equal(props.tab_visibility, 'hidden', 'tab_visibility must survive with its value');
    // And the base identity is still there next to the enrichment.
    assert.equal(props.device_lost_reason, 'unknown');
    assert.equal(props.device_lost_detail, DAWN_LOST);

    // Control: the scrubber is live in this test. A key spelled into its word
    // list really is deleted, so the assertions above cannot pass vacuously.
    const withBadKey = scrubEvent({
      event: '$exception',
      properties: { gpu_description: 'free text', last_load_model_mb: 1 },
    });
    assert.equal(withBadKey?.properties?.gpu_description, undefined);
    assert.equal(withBadKey?.properties?.last_load_model_mb, undefined);
  });
});

describe('a hostile source cannot break the loss path', () => {
  it('throwing accessors cost their own fields, never the build', () => {
    const hostile: DeviceLossContextSource = {
      getAdapterInfo: () => { throw new Error('adapter gone'); },
      getFrameStats: () => { throw new Error('stats gone'); },
      getScene: () => { throw new Error('scene gone'); },
      getCanvas: () => { throw new Error('canvas gone'); },
    };
    let context: Record<string, unknown> = {};
    assert.doesNotThrow(() => { context = buildDeviceLossContext(hostile); });

    assert.ok(!('gpu_vendor' in context));
    assert.ok(!('had_rendered_frame' in context));
    assert.ok(!('gpu_resident_mb' in context));
    assert.ok(!('canvas_width' in context));
    // Fields with healthy sources still make it out - the try/catch is
    // per-field, not around the whole build.
    assert.equal(typeof context.ms_since_page_load, 'number');
    assert.equal(typeof context.geometry_mode, 'string');
  });

  it('a getScene that returns, then throws mid-call, costs only gpu_resident_mb', () => {
    const midCall: DeviceLossContextSource = {
      ...makeFullSource(),
      getScene: () => ({
        getResidentGpuBytes: (): { total: number } => { throw new Error('buffers torn down'); },
      }),
    };
    const context = buildDeviceLossContext(midCall);
    assert.ok(!('gpu_resident_mb' in context));
    assert.equal(context.gpu_vendor, 'testvendor', 'the neighbouring fields are untouched');
  });

  it('reportDeviceLost still captures the base reason with a degraded context', () => {
    const hostile: DeviceLossContextSource = {
      getAdapterInfo: () => { throw new Error('adapter gone'); },
    };
    reportDeviceLost({ message: DAWN_LOST, reason: 'unknown' }, buildDeviceLossContext(hostile));
    assert.equal(captures.length, 1, 'the loss must reach error tracking regardless');
    assert.equal(captures[0].props?.device_lost_reason, 'unknown');
    assert.equal(captures[0].props?.device_lost_detail, DAWN_LOST);
  });
});

describe('tab_visibility document guard', () => {
  it('is omitted where document does not exist (this very environment)', () => {
    // Not a simulation: node:test genuinely has no `document`, which is why
    // the production read must be guarded with `typeof document`.
    assert.equal(typeof document, 'undefined', 'premise: this harness has no DOM');
    const context = buildDeviceLossContext(makeFullSource());
    assert.ok(!('tab_visibility' in context));
  });

  it('reports the live visibility state when a document exists', () => {
    stubDocument('hidden');
    const context = buildDeviceLossContext(makeFullSource());
    assert.equal(context.tab_visibility, 'hidden', 'the value must be read, not hardcoded');
  });
});

describe('first-render discrimination', () => {
  it('null frame stats: had_rendered_frame false and no ms_since_last_frame', () => {
    const context = buildDeviceLossContext({ ...makeFullSource(), getFrameStats: () => null });
    assert.equal(
      context.had_rendered_frame,
      false,
      'a loss before the first frame is a different bug family and must say so',
    );
    assert.ok(
      !('ms_since_last_frame' in context),
      'no frame means no last-frame delta - absent, not 0 or NaN',
    );
  });

  it('a frame 250ms ago: had_rendered_frame true and a plausible positive delta', () => {
    const context = buildDeviceLossContext({
      ...makeFullSource(),
      getFrameStats: () => ({ timestamp: performance.now() - 250 }),
    });
    assert.equal(context.had_rendered_frame, true);
    const delta = context.ms_since_last_frame;
    assert.equal(typeof delta, 'number');
    assert.ok(
      (delta as number) >= 200 && (delta as number) <= 5000,
      `delta must be now - timestamp (got ${String(delta)}): a flipped subtraction goes negative`,
    );
  });
});

describe('subscribeViewportHealth delivers the enrichment (#2624)', () => {
  function makeRenderer() {
    const listeners = {
      deviceLost: [] as Array<(info: { message: string; reason: string }) => void>,
      degradation: [] as Array<(info: { consecutiveDegradedFrames: number; detail: string; origin: 'frame' | 'encode' }) => void>,
    };
    const renderer: ViewportHealthSource = {
      onDeviceLost(listener) {
        listeners.deviceLost.push(listener);
        return () => { /* unsubscribe */ };
      },
      onPersistentRenderDegradation(listener) {
        listeners.degradation.push(listener);
        return () => { /* unsubscribe */ };
      },
      getAdapterInfo: () => ({ vendor: 'testvendor', architecture: 'testarch' }),
    };
    return { renderer, listeners };
  }

  it('a loss fired through the wiring arrives WITH context, built at loss time', () => {
    const { renderer, listeners } = makeRenderer();
    subscribeViewportHealth(renderer);

    listeners.deviceLost[0]({ message: DAWN_LOST, reason: 'unknown' });

    assert.equal(captures.length, 1);
    const props = captures[0].props ?? {};
    assert.equal(
      props.gpu_vendor,
      'testvendor',
      'wiring reverted to onDeviceLost(reportDeviceLost) would drop every enrichment field',
    );
    assert.equal(props.device_lost_reason, 'unknown');
  });

  it('the degradation channel carries the same context - the two are triaged together', () => {
    const { renderer, listeners } = makeRenderer();
    subscribeViewportHealth(renderer);

    listeners.degradation[0]({ consecutiveDegradedFrames: 16, detail: 'boom', origin: 'frame' });

    assert.equal(captures.length, 1);
    const props = captures[0].props ?? {};
    assert.equal(props.context, 'render_degraded');
    assert.equal(props.gpu_vendor, 'testvendor', '#2417 events get the #2624 enrichment too');
  });
});

describe('base fields cannot be shadowed by the context spread', () => {
  it('a context claiming device_lost_reason / context does not win', () => {
    reportDeviceLost(
      { message: DAWN_LOST, reason: 'unknown' },
      { context: 'spoofed', device_lost_reason: 'spoofed', device_lost_detail: 'spoofed' },
    );
    const props = captures[0].props ?? {};
    assert.equal(props.context, 'device_lost', 'the tag is the event identity - spread order is load-bearing');
    assert.equal(props.device_lost_reason, 'unknown');
    assert.equal(props.device_lost_detail, DAWN_LOST);
  });

  it('the same holds on the degradation path', () => {
    reportPersistentRenderDegradation(
      { consecutiveDegradedFrames: 16, detail: 'boom', origin: 'frame' },
      { context: 'spoofed', render_degraded_origin: 'spoofed' },
    );
    const props = captures[0].props ?? {};
    assert.equal(props.context, 'render_degraded');
    assert.equal(props.render_degraded_origin, 'frame');
  });
});
