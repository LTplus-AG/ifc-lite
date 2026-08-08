/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `onDeviceLost` subscriber (#2229).
 *
 * Before this, no part of apps/viewer subscribed to `renderer.onDeviceLost`,
 * so a GPU loss was invisible: the viewer stopped drawing, the user got no
 * explanation, and error tracking got either nothing (Chromium — the renderer
 * contains the loss silently) or an untagged uncaught DOMException (Safari).
 * These tests pin what the subscriber must do, and that it stays cheap enough
 * to be safe on a path that fires from inside the renderer's listener loop.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { RenderDegradationInfo } from '@ifc-lite/renderer';
import { posthog } from '@/lib/analytics';
import { scrubEvent } from '@/lib/analytics-scrub.js';
import { toast } from '@/components/ui/toast';
import {
  reportDeviceLost,
  reportPersistentRenderDegradation,
  resetDeviceLossReportForTests,
  subscribeViewportHealth,
  type ViewportHealthSource,
} from './device-loss-report.js';

/** Verbatim Safari 26.5 wording from the #2229 PostHog frames. */
const SAFARI_LOST = 'The object is in an invalid state.';

interface Captured { err: unknown; props: Record<string, unknown> | undefined }

let captures: Captured[] = [];
let warnings: unknown[][] = [];
const realWarn = console.warn;
const realCapture = posthog.captureException;

beforeEach(() => {
  resetDeviceLossReportForTests();
  captures = [];
  warnings = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  posthog.captureException = ((err: unknown, props?: Record<string, unknown>) => {
    captures.push({ err, props });
  }) as typeof posthog.captureException;
});

afterEach(() => {
  console.warn = realWarn;
  posthog.captureException = realCapture;
});

describe('reportDeviceLost', () => {
  it('captures the loss tagged as device_lost, carrying reason and detail', () => {
    reportDeviceLost({ message: SAFARI_LOST, reason: 'render-exception' });

    assert.equal(captures.length, 1, 'the loss must reach error tracking');
    const props = captures[0].props ?? {};
    assert.equal(
      props.context,
      'device_lost',
      'without the tag the loss lands as an unattributable raw exception — the #2229 status quo',
    );
    assert.equal(props.device_lost_reason, 'render-exception');
    assert.equal(props.device_lost_detail, SAFARI_LOST);
    assert.match(
      String((captures[0].err as Error).message),
      /invalid state/i,
      'the GPU message must survive into the captured exception',
    );
  });

  it('reports once per session, not once per listener call', () => {
    // A device can announce its death more than once (the sync throw latch AND
    // the async device.lost promise, on browsers that eventually resolve it),
    // and the component can remount. The user must not be toasted twice.
    for (let i = 0; i < 10; i++) {
      reportDeviceLost({ message: SAFARI_LOST, reason: 'render-exception' });
    }
    assert.equal(captures.length, 1);
    assert.equal(warnings.length, 1);
  });

  it('never throws, even when error tracking itself fails', () => {
    // It runs inside the renderer's listener loop; a throw here would be
    // caught and logged there, but would still cost whatever the loss handler
    // does after it.
    posthog.captureException = (() => { throw new Error('posthog exploded'); }) as typeof posthog.captureException;
    assert.doesNotThrow(() => reportDeviceLost({ message: SAFARI_LOST, reason: 'unknown' }));
  });

  it('leaves a console breadcrumb naming the reason', () => {
    reportDeviceLost({ message: SAFARI_LOST, reason: 'render-exception' });
    assert.equal(warnings.length, 1);
    assert.ok(
      warnings[0].some((a) => String(a).includes('render-exception')),
      'the reason distinguishes a synchronous Safari loss from an async device.lost one',
    );
  });

  it('carries the GPU detail THROUGH the real privacy scrubber, not just to the capture call', () => {
    // The trap this pins: every captured event passes `scrubEvent`
    // (`before_send`), which DELETES any property whose key contains `message`
    // as a `_`-delimited word. `device_lost_message` matched, so the detail was
    // dropped in production while the assertion above — which stubs
    // `captureException`, i.e. sits ABOVE the scrubber — stayed green.
    //
    // Asserting through the real scrubber is the only version of this test that
    // can fail if someone renames the key back into that word list.
    reportDeviceLost({ message: SAFARI_LOST, reason: 'render-exception' });
    const props = { ...(captures[0].props ?? {}) };
    const sent = scrubEvent({ event: '$exception', properties: props });

    assert.ok(sent, 'the device-loss event must not be dropped as third-party noise');
    assert.equal(
      sent.properties?.device_lost_detail,
      SAFARI_LOST,
      'the GPU text must survive before_send — without it the issue is untriageable',
    );
    assert.equal(
      sent.properties?.device_lost_reason,
      'render-exception',
      'and so must the reason (`reason` is not a sensitive word)',
    );

    // The control, so the assertion above cannot pass for the wrong reason: the
    // scrubber really does delete the old key name.
    const withOldKey = scrubEvent({
      event: '$exception',
      properties: { device_lost_message: SAFARI_LOST },
    });
    assert.equal(
      withOldKey?.properties?.device_lost_message,
      undefined,
      'proof the scrubber is live in this test: the `_message` spelling is deleted',
    );
  });
});

describe('reportDeviceLost tells the USER, not only error tracking', () => {
  // The headline of #2229 is "make the loss visible". Telemetry is the half we
  // see; the toast is the half the user sees, and it was entirely unpinned —
  // deleting the whole toast block left the suite green.
  //
  // Seam: the production code loads the toast module dynamically (to keep this
  // render-path module free of UI imports), but a dynamic import resolves to
  // the SAME module instance as this file's static one, so the repo's existing
  // pattern — `mock.method(toast, 'error')`, as ExportChangesButton.test.tsx
  // uses — works without adding an injection point to production code.

  /** Let the fire-and-forget `import(...).then(...)` in reportDeviceLost settle. */
  const flushDynamicImport = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('raises exactly one toast, telling the user a reload is what fixes it', async () => {
    // Drain toasts still in flight from EARLIER tests in this file first — the
    // dynamic import settles on a later tick, so without this they land inside
    // this test's spy and the count is whatever the file's test order happens
    // to produce.
    await flushDynamicImport();
    const errorToast = mock.method(toast, 'error', () => 0);
    try {
      reportDeviceLost({ message: SAFARI_LOST, reason: 'render-exception' });
      await flushDynamicImport();

      assert.equal(errorToast.mock.callCount(), 1, 'a stopped viewport must say so on screen');
      const text = String(errorToast.mock.calls[0].arguments[0]);
      assert.match(text, /reload/i, 'the toast must name the only action that restores rendering');
      assert.match(text, /graphics device/i, 'and name the cause, not just "something went wrong"');
    } finally {
      errorToast.mock.restore();
    }
  });

  it('does not toast a second time — the session latch covers the UI too', async () => {
    // A device can announce its death twice (the sync throw AND the async
    // device.lost promise), and the Viewport can remount. Neither may re-toast.
    // Drain toasts still in flight from EARLIER tests in this file first — the
    // dynamic import settles on a later tick, so without this they land inside
    // this test's spy and the count is whatever the file's test order happens
    // to produce.
    await flushDynamicImport();
    const errorToast = mock.method(toast, 'error', () => 0);
    try {
      reportDeviceLost({ message: SAFARI_LOST, reason: 'render-exception' });
      reportDeviceLost({ message: SAFARI_LOST, reason: 'device-lost-promise' });
      await flushDynamicImport();

      assert.equal(errorToast.mock.callCount(), 1, 'one loss, one toast');
    } finally {
      errorToast.mock.restore();
    }
  });
});

describe('reportPersistentRenderDegradation (#2417)', () => {
  // The neighbouring failure: the renderer deliberately does NOT latch on a
  // throw that is not a device-loss signal, so a failure that never clears has
  // no `deviceLost` state behind it — but the user is looking at the same
  // stopped viewport, and until this existed we saw nothing at all.

  const DEGRADED = {
    degradedFrames: 16,
    detail: 'createBuffer failed, size (193836) is too large',
    origin: 'encode',
  } as const;

  it('captures the degradation tagged as render_degraded, with count and origin', () => {
    reportPersistentRenderDegradation(DEGRADED);

    assert.equal(captures.length, 1, 'a wedged viewport must reach error tracking');
    const props = captures[0].props ?? {};
    assert.equal(
      props.context,
      'render_degraded',
      'a distinct tag from device_lost — the device is alive here, and the triage differs',
    );
    assert.equal(props.render_degraded_frames, 16);
    assert.equal(props.render_degraded_origin, 'encode');
    assert.equal(props.render_degraded_detail, DEGRADED.detail);
  });

  it('reports once per session', () => {
    for (let i = 0; i < 10; i++) reportPersistentRenderDegradation(DEGRADED);
    assert.equal(captures.length, 1);
  });

  it('has its own latch, so it does not mute a later device loss', () => {
    // A session can degrade for a while and THEN lose the device. Sharing one
    // latch would drop whichever arrived second — and the device loss is the
    // more serious of the two.
    reportPersistentRenderDegradation(DEGRADED);
    reportDeviceLost({ message: SAFARI_LOST, reason: 'render-exception' });
    assert.equal(captures.length, 2, 'two different failures, two reports');
    assert.equal(captures[0].props?.context, 'render_degraded');
    assert.equal(captures[1].props?.context, 'device_lost');
  });

  it('never throws, even when error tracking itself fails', () => {
    posthog.captureException = (() => { throw new Error('posthog exploded'); }) as typeof posthog.captureException;
    assert.doesNotThrow(() => reportPersistentRenderDegradation(DEGRADED));
  });

  it('carries the GPU detail THROUGH the real privacy scrubber', () => {
    // Same trap as `device_lost_detail`: `scrubEvent` DELETES any property key
    // containing `message` as a `_`-delimited word, and a test that stubs
    // `captureException` sits ABOVE the scrubber, so a `_message` spelling would
    // ship with the text silently dropped and this file still green.
    reportPersistentRenderDegradation(DEGRADED);
    const sent = scrubEvent({ event: '$exception', properties: { ...(captures[0].props ?? {}) } });

    assert.ok(sent, 'the degradation event must not be dropped as third-party noise');
    assert.equal(
      sent.properties?.render_degraded_detail,
      DEGRADED.detail,
      'the GPU text must survive before_send — without it the issue is untriageable',
    );
    assert.equal(sent.properties?.render_degraded_origin, 'encode');
    assert.equal(sent.properties?.render_degraded_frames, 16);

    // The control, so the assertion above cannot pass for the wrong reason.
    const withOldKey = scrubEvent({
      event: '$exception',
      properties: { render_degraded_message: DEGRADED.detail },
    });
    assert.equal(
      withOldKey?.properties?.render_degraded_message,
      undefined,
      'proof the scrubber is live in this test: the `_message` spelling is deleted',
    );
  });
});

describe('subscribeViewportHealth wires every way the view can stop', () => {
  // Both channels are subscribed in one tested unit rather than inline in
  // Viewport's init effect, so adding a channel and forgetting to wire it is a
  // failing test instead of an omission nobody sees.

  function makeSource() {
    const listeners = {
      deviceLost: [] as Array<(info: { message: string; reason: string }) => void>,
      degradation: [] as Array<(info: RenderDegradationInfo) => void>,
    };
    const info: RenderDegradationInfo = { degradedFrames: 16, detail: 'boom', origin: 'frame' };
    let unsubscribes = 0;
    const source: ViewportHealthSource = {
      onDeviceLost(listener) {
        listeners.deviceLost.push(listener);
        return () => { unsubscribes++; };
      },
      onPersistentRenderDegradation(listener) {
        listeners.degradation.push(listener);
        return () => { unsubscribes++; };
      },
    };
    return { source, listeners, info, unsubscribeCount: () => unsubscribes };
  }

  it('subscribes to BOTH device loss and persistent degradation', () => {
    const h = makeSource();
    subscribeViewportHealth(h.source);
    assert.equal(h.listeners.deviceLost.length, 1, 'device loss must stay wired');
    assert.equal(h.listeners.degradation.length, 1, 'and degradation must be wired too');
  });

  it('routes each channel to its own reporter', () => {
    const h = makeSource();
    subscribeViewportHealth(h.source);

    h.listeners.degradation[0](h.info);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].props?.context, 'render_degraded');

    h.listeners.deviceLost[0]({ message: SAFARI_LOST, reason: 'render-exception' });
    assert.equal(captures.length, 2);
    assert.equal(captures[1].props?.context, 'device_lost');
  });

  it('returns one unsubscribe that detaches every channel', () => {
    // Viewport calls this exactly once on teardown; a partial detach leaks a
    // listener into a renderer that is about to be destroyed.
    const h = makeSource();
    const unsubscribe = subscribeViewportHealth(h.source);
    unsubscribe();
    assert.equal(h.unsubscribeCount(), 2, 'every subscription must be released');
  });
});
