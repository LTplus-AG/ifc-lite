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
import { posthog } from '@/lib/analytics';
import { scrubEvent } from '@/lib/analytics-scrub.js';
import { toast } from '@/components/ui/toast';
import { reportDeviceLost, resetDeviceLossReportForTests } from './device-loss-report.js';

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
