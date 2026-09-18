/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSuppressForeignScriptNoise } from './foreign-script-noise.js';
import { beforeSend } from './analytics.js';

// The two exceptions recorded for issue #4939, transcribed from the PostHog
// event's `$exception_list` (project 199147, issue
// 01a0b0ea-ed05-78c0-b44a-86b17091aa92; session
// 01a0b0ea-e733-7ed6-a7ce-beac54c156bb, Safari 17.6 / Mac OS X, 2026-09-17
// 19:49:40Z, 12 ms apart, on https://www.ifclite.com/). Both are WebExtension
// API shapes thrown from a script whose URL WebKit masks — a content script
// reading `browser.tabs` results and then the reply of a `runtime.sendMessage`.
//
// Frame shape is posthog-js's CLIENT-SIDE one (`filename`/`lineno`/`colno`/
// `in_app`, `stacktrace.type: 'raw'`), because `before_send` runs in the
// browser, before ingestion rewrites frames into the resolved form.
const maskedFrame = (lineno: number, colno: number) => ({
  platform: 'web:javascript',
  filename: 'webkit-masked-url://hidden/',
  function: '?',
  lineno,
  colno,
  in_app: false,
});

const ISSUE_4939_TAB_ID = {
  type: 'TypeError',
  value: "undefined is not an object (evaluating 'tab.id')",
  mechanism: { handled: false, synthetic: false, type: 'generic' as const },
  stacktrace: { type: 'raw' as const, frames: [maskedFrame(21622, 17)] },
};

const ISSUE_4939_RESPONSE_TYPE = {
  type: 'TypeError',
  value: "undefined is not an object (evaluating 'response.type')",
  mechanism: { handled: false, synthetic: false, type: 'generic' as const },
  stacktrace: { type: 'raw' as const, frames: [maskedFrame(4273, 15)] },
};

const exceptionEvent = (list: unknown[]) => ({
  event: '$exception',
  properties: {
    $exception_list: list,
    $current_url: 'https://www.ifclite.com/',
    $browser: 'Safari',
  },
});

/** A frame from the viewer's own deployed bundle. */
const appFrame = (fn: string) => ({
  platform: 'web:javascript',
  filename: 'https://www.ifclite.com/assets/index-Cq8s1ktZ.js',
  function: fn,
  lineno: 412,
  colno: 9,
  in_app: true,
});

describe('foreign-script noise gate (#4939)', () => {
  it("drops the recorded 'tab.id' throw from the masked Safari extension script", () => {
    // Fails before the fix: the exception carries a real frame, so the
    // frameCount === 0 gates in analytics-scrub.ts never fire and the event
    // reaches error tracking, which files it as a viewer bug.
    assert.equal(shouldSuppressForeignScriptNoise(exceptionEvent([ISSUE_4939_TAB_ID])), true);
  });

  it("drops the sibling 'response.type' throw from the same session", () => {
    assert.equal(
      shouldSuppressForeignScriptNoise(exceptionEvent([ISSUE_4939_RESPONSE_TYPE])),
      true,
    );
  });

  it('drops a multi-entry event only when every entry is foreign', () => {
    assert.equal(
      shouldSuppressForeignScriptNoise(
        exceptionEvent([ISSUE_4939_TAB_ID, ISSUE_4939_RESPONSE_TYPE]),
      ),
      true,
    );
  });

  it('drops the Chromium and Gecko extension schemes too', () => {
    for (const filename of [
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js',
      'moz-extension://11111111-2222-3333-4444-555555555555/inject.js',
      'safari-web-extension://ABCDEF01-2345-6789/content.js',
    ]) {
      const event = exceptionEvent([
        {
          type: 'TypeError',
          value: "undefined is not an object (evaluating 'tab.id')",
          mechanism: { handled: false },
          stacktrace: { type: 'raw', frames: [{ ...maskedFrame(10, 1), filename }] },
        },
      ]);
      assert.equal(shouldSuppressForeignScriptNoise(event), true, filename);
    }
  });

  it('keeps a throw that has any frame of ours, even under a masked top frame', () => {
    // An extension that breaks the viewer THROUGH our call stack is still ours
    // to see: attribution is per-event, and one app frame disqualifies the drop.
    const mixed = {
      ...ISSUE_4939_TAB_ID,
      stacktrace: {
        type: 'raw' as const,
        frames: [maskedFrame(21622, 17), appFrame('RibbonToolbar')],
      },
    };
    assert.equal(shouldSuppressForeignScriptNoise(exceptionEvent([mixed])), false);
  });

  it('keeps an identical message thrown from our own bundle', () => {
    // The gate must key on WHO threw, not on the wording — otherwise a real
    // regression in RibbonToolbar or WidgetRenderer would be deleted silently.
    const ours = {
      ...ISSUE_4939_TAB_ID,
      stacktrace: { type: 'raw' as const, frames: [appFrame('WidgetRenderer')] },
    };
    assert.equal(shouldSuppressForeignScriptNoise(exceptionEvent([ours])), false);
  });

  it('keeps a deliberate captureException, whatever its frames say', () => {
    const handled = {
      ...ISSUE_4939_TAB_ID,
      mechanism: { handled: true, synthetic: false, type: 'generic' as const },
    };
    assert.equal(shouldSuppressForeignScriptNoise(exceptionEvent([handled])), false);
  });

  it('keeps a frameless exception — the frameless gates own that case', () => {
    const frameless = { type: 'TypeError', value: 'Script error.', mechanism: { handled: false } };
    assert.equal(shouldSuppressForeignScriptNoise(exceptionEvent([frameless])), false);
    assert.equal(
      shouldSuppressForeignScriptNoise({
        event: '$exception',
        properties: { $exception_list: [] },
      }),
      false,
    );
  });

  it('keeps non-exception events and null', () => {
    assert.equal(
      shouldSuppressForeignScriptNoise({
        event: '$pageview',
        properties: { $exception_list: [ISSUE_4939_TAB_ID] },
      }),
      false,
    );
    assert.equal(shouldSuppressForeignScriptNoise(null), false);
  });
});

// Only a test of `beforeSend` itself can catch the gate being disconnected from
// the pipeline, which is the failure that would silently restore the noise.
// Same rationale as the wasm/chunk skew gates' wiring tests in analytics.test.ts.
describe('beforeSend wiring (#4939)', () => {
  it('returns null for the recorded #4939 event', () => {
    assert.equal(beforeSend(exceptionEvent([ISSUE_4939_TAB_ID])), null);
  });

  it('still returns an event for the same message thrown by our bundle', () => {
    const ours = {
      ...ISSUE_4939_TAB_ID,
      stacktrace: { type: 'raw' as const, frames: [appFrame('WidgetRenderer')] },
    };
    const result = beforeSend(exceptionEvent([ours]));
    assert.notEqual(result, null);
    assert.equal(result?.event, '$exception');
  });
});
