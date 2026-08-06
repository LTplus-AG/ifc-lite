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

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { posthog } from '@/lib/analytics';
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
  it('captures the loss tagged as device_lost, carrying reason and message', () => {
    reportDeviceLost({ message: SAFARI_LOST, reason: 'render-exception' });

    assert.equal(captures.length, 1, 'the loss must reach error tracking');
    const props = captures[0].props ?? {};
    assert.equal(
      props.context,
      'device_lost',
      'without the tag the loss lands as an unattributable raw exception — the #2229 status quo',
    );
    assert.equal(props.device_lost_reason, 'render-exception');
    assert.equal(props.device_lost_message, SAFARI_LOST);
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
});
