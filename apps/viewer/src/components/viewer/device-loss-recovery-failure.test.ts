/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `device_loss_recovery_failed` used to carry only `reason`, so the 31 field
 * `device-init-failed` events of one month could not say which step failed.
 * These tests run the event through the real `scrubEvent`, because a key the
 * scrubber deletes passes every test that stubs `capture` above it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DeviceRecoveryResult } from '@ifc-lite/renderer';
import { posthog } from '@/lib/analytics';
import { scrubEvent } from '@/lib/analytics-scrub.js';
import { resetDeviceLossReportForTests, subscribeViewportHealth, type ViewportHealthSource } from './device-loss-report.js';
import { startDeviceLossRecovery, type DeviceRecoveryAttempts } from './device-loss-recovery.js';
import { recoveryFailureProperties } from './device-loss-recovery-failure.js';

type Failure = Extract<DeviceRecoveryResult, { ok: false }>;

let events: Array<{ event: string; props: Record<string, unknown> }> = [];
const realCapture = posthog.capture;
const realCaptureException = posthog.captureException;
const realWarn = console.warn;

beforeEach(() => {
  resetDeviceLossReportForTests();
  events = [];
  posthog.capture = ((event: string, props?: Record<string, unknown>) => {
    events.push({ event, props: props ?? {} });
  }) as typeof posthog.capture;
  posthog.captureException = (() => undefined) as unknown as typeof posthog.captureException;
  console.warn = () => undefined;
});

afterEach(() => {
  posthog.capture = realCapture;
  posthog.captureException = realCaptureException;
  console.warn = realWarn;
});

function source(results: Failure[], vendor?: string) {
  let lost: ((info: { message: string; reason: string }) => void) | null = null;
  const queue = [...results];
  const renderer: ViewportHealthSource = {
    onDeviceLost: (listener) => { lost = listener; return () => { lost = null; }; },
    onPersistentRenderDegradation: () => () => undefined,
    recoverDevice: async () => queue.shift() ?? results[results.length - 1],
    getAdapterInfo: () => (vendor ? { vendor } : null),
  };
  return {
    renderer,
    lose: () => lost?.({ message: 'A valid external Instance reference no longer exists.', reason: 'unknown' }),
  };
}

async function failureEvent(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100 && !events.some((e) => e.event === 'device_loss_recovery_failed'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const captured = events.find((e) => e.event === 'device_loss_recovery_failed');
  assert.ok(captured, 'the failed recovery must be captured');
  events = events.filter((e) => e !== captured);
  const scrubbed = scrubEvent({ event: captured.event, properties: { ...captured.props } });
  return scrubbed?.properties ?? {};
}

describe('device_loss_recovery_failed carries what failed', () => {
  it('keeps both attempts\' error text and the GPU context through the real scrubber', async () => {
    // The shape a forced second GPU-process crash produced in Chrome: no adapter, twice.
    const h = source([
      { ok: false, reason: 'device-init-failed', error: new DOMException('No adapter yet', 'OperationError') },
      { ok: false, reason: 'device-init-failed', error: new Error('Failed to get GPU adapter') },
    ], 'nvidia');
    const unsubscribe = subscribeViewportHealth(h.renderer);
    try {
      h.lose();
      const props = await failureEvent();
      assert.equal(props.reason, 'device-init-failed');
      assert.equal(props.recovery_error_kind, 'Error');
      assert.equal(props.recovery_error_detail, 'Failed to get GPU adapter');
      assert.equal(props.recovery_first_reason, 'device-init-failed');
      assert.equal(props.recovery_first_error_kind, 'OperationError');
      assert.equal(props.recovery_first_error_detail, 'No adapter yet');
      assert.equal(props.recovery_attempts, 2);
      assert.equal(typeof props.recovery_episode, 'number');
      assert.ok(typeof props.recovery_elapsed_ms === 'number' && props.recovery_elapsed_ms >= 0);
      assert.equal(props.gpu_vendor, 'nvidia');
      assert.equal(typeof props.ms_since_page_load, 'number');
    } finally {
      unsubscribe();
    }
  });

  it('numbers episodes per document, which is the scope Chrome limits adapters by', async () => {
    const h = source([{ ok: false, reason: 'cold-restore-failed', error: new Error('scene') }]);
    const unsubscribe = subscribeViewportHealth(h.renderer);
    try {
      h.lose();
      const first = await failureEvent();
      h.lose();
      const second = await failureEvent();
      assert.equal(second.recovery_episode, Number(first.recovery_episode) + 1);
      assert.equal(first.recovery_attempts, 1, 'a non-retryable reason is not retried');
      assert.equal(first.recovery_first_reason, undefined);
      assert.equal(first.gpu_vendor, undefined, 'no adapter was granted, so no vendor is claimed');
    } finally {
      unsubscribe();
    }
  });

  it('bounds browser-supplied text and survives a non-Error rejection', async () => {
    let attempts: DeviceRecoveryAttempts | undefined;
    const run = startDeviceLossRecovery(
      { recoverDevice: async () => { throw 'x'.repeat(1000); } },
      { recovered: () => assert.fail('must fail'), failed: (_result, info) => { attempts = info; } },
      async () => undefined,
    );
    const result = await run.promise;
    if (result.ok || !attempts) return assert.fail('must fail with attempts');
    const props = recoveryFailureProperties(result, attempts);
    assert.equal(props.recovery_error_kind, 'string');
    assert.equal(String(props.recovery_error_detail).length, 300);
    assert.equal(props.recovery_attempts, 2);
  });
});
