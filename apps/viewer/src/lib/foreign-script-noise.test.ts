/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beforeSend } from './analytics.js';

// Everything here is observed through `beforeSend` — the real `before_send`
// PostHog is initialised with — and NOT through a direct import of
// ./foreign-script-noise.js, deliberately.
//
// Two reasons, and the second is the load-bearing one:
//
//  1. Only a test of the pipeline entry point can catch the gate being
//     disconnected from it, which is the failure that would silently restore
//     the noise. (Same rationale as the wasm/chunk skew gates' wiring tests in
//     ./analytics.test.ts.)
//  2. `scripts/check-test-revert-oracle.mjs` reverts the production change and
//     requires these tests to fail BY ASSERTION. The fix for #4939 ADDS a
//     module, so a test importing it directly dies with ERR_MODULE_NOT_FOUND
//     under the revert — the file never loads, no assertion runs, and the
//     oracle cannot tell a real regression test from a vacuous one. `analytics.ts`
//     is modified rather than added, so it still loads after the revert, with
//     the gate simply absent: the drop assertions below then fail as assertions,
//     which is exactly the signal the oracle is asking for.
//
// `beforeSend` returns `null` to DROP an event and the (scrubbed) event to keep
// it, so `null` is the whole observable behaviour under test.

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

describe('foreign-script noise gate, through before_send (#4939)', () => {
  it("drops the recorded 'tab.id' throw from the masked Safari extension script", () => {
    // Fails by assertion when the gate is absent: the exception carries a real
    // frame, so the frameCount === 0 arms in analytics-scrub.ts never fire and
    // `beforeSend` returns the event, which error tracking then files as a
    // viewer bug.
    assert.equal(beforeSend(exceptionEvent([ISSUE_4939_TAB_ID])), null);
  });

  it("drops the sibling 'response.type' throw from the same session", () => {
    assert.equal(beforeSend(exceptionEvent([ISSUE_4939_RESPONSE_TYPE])), null);
  });

  it('drops a multi-entry event when every entry is foreign', () => {
    assert.equal(beforeSend(exceptionEvent([ISSUE_4939_TAB_ID, ISSUE_4939_RESPONSE_TYPE])), null);
  });

  it('drops the Chromium, Gecko and Safari web-extension schemes too', () => {
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
      assert.equal(beforeSend(event), null, filename);
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
    const kept = beforeSend(exceptionEvent([mixed]));
    assert.notEqual(kept, null);
    assert.equal(kept?.event, '$exception');
  });

  it('keeps an identical message thrown from our own bundle', () => {
    // The gate must key on WHO threw, not on the wording — otherwise a real
    // regression in RibbonToolbar or WidgetRenderer would be deleted silently.
    const ours = {
      ...ISSUE_4939_TAB_ID,
      stacktrace: { type: 'raw' as const, frames: [appFrame('WidgetRenderer')] },
    };
    const kept = beforeSend(exceptionEvent([ours]));
    assert.notEqual(kept, null);
    assert.equal(kept?.event, '$exception');
  });

  it('keeps a deliberate captureException, whatever its frames say', () => {
    const handled = {
      ...ISSUE_4939_TAB_ID,
      mechanism: { handled: true, synthetic: false, type: 'generic' as const },
    };
    assert.notEqual(beforeSend(exceptionEvent([handled])), null);
  });

  it('keeps a frameless exception — the frameless arms in the scrub own that case', () => {
    // Same #4939 wording with no `stacktrace` at all (the production shape from
    // #1903). An absent stack is not evidence of a foreign script, so this gate
    // must not claim it; a bare "Script error." is deliberately NOT used here
    // because analytics-scrub.ts already drops that one on its own.
    const frameless = {
      type: 'TypeError',
      value: "undefined is not an object (evaluating 'tab.id')",
      mechanism: { handled: false },
    };
    assert.notEqual(beforeSend(exceptionEvent([frameless])), null);
    assert.notEqual(
      beforeSend({ event: '$exception', properties: { $exception_list: [] } }),
      null,
    );
  });

  it('keeps a non-exception event captured while an extension is present', () => {
    assert.notEqual(
      beforeSend({
        event: '$pageview',
        properties: { $exception_list: [ISSUE_4939_TAB_ID] },
      }),
      null,
    );
  });
});
