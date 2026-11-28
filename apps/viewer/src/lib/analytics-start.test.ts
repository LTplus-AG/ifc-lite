/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * When PostHog may start, and what it may record once it has.
 *
 * The opt-out and the first-visit notice decide whether the SDK is initialised
 * at all: before that it stores no identifier and makes no request. The init
 * configuration switches off everything that could carry page text (replay,
 * autocapture, heatmaps, dead and rage clicks, console logs), independently of
 * the PostHog project's settings. Both run through the installed SDK here.
 *
 * New exports are read through the module namespace and asserted, so a revert
 * of the production change fails these tests by assertion, not at import.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PostHog } from 'posthog-js/lib/src/posthog-core.js';
import * as analytics from './analytics.js';
import * as consent from './analytics-consent.js';

type Starter = { start: () => void; attempt: () => void; isInitialised: () => boolean };
type StarterDeps = {
  configured: boolean;
  init: () => void;
  isOptedOut: () => boolean;
  isNoticeShown: () => boolean;
  subscribe: (listener: () => void) => void;
};
const added = analytics as typeof analytics & {
  createAnalyticsStarter?: (deps: StarterDeps) => Starter;
  analyticsInitConfig?: (apiHost: string) => Record<string, unknown>;
  createHeldAnalytics?: (cap: number, holdFromStart: boolean, prepareError: (error: unknown) => unknown, sendUncaught?: SendUncaught) => Held;
  listenForUncaught?: (target: EventTarget, hold: (error: unknown) => void, isOptedOut: () => boolean) => () => void;
};
type SendUncaught = (target: Held['client'], error: unknown, properties: Record<string, unknown>) => void;
type Recorded = { kind: 'capture' | 'exception'; name?: string; error?: unknown; properties?: Record<string, unknown>; timestamp?: Date };
type Held = {
  client: { capture: (event: string, properties?: Record<string, unknown>, options?: { timestamp?: Date }) => unknown; captureException: (error: unknown, properties?: Record<string, unknown>) => unknown };
  holdUncaught: (error: unknown) => void;
  flush: (target: Held['client']) => void;
  clear: () => void;
  stop: () => void;
  size: () => number;
};
function recorder(): { events: Recorded[]; target: Held['client'] } {
  const events: Recorded[] = [];
  return {
    events,
    target: {
      capture: (name, properties, options) => { events.push({ kind: 'capture', name, properties, timestamp: options?.timestamp }); return undefined; },
      captureException: (error, properties) => { events.push({ kind: 'exception', error, properties }); return undefined; },
    },
  };
}
/** Every PostHog entry this browser holds, in all three stores. */
function postHogEntries(): string[] {
  const keys = (storage: Storage) => Array.from({ length: storage.length }, (_, i) => storage.key(i) ?? '');
  return [
    ...keys(localStorage).filter((key) => key.startsWith('ph_')).map((key) => `local:${key}`),
    ...keys(sessionStorage).filter((key) => key.startsWith('ph_')).map((key) => `session:${key}`),
    ...document.cookie.split(';').map((part) => part.split('=')[0]!.trim()).filter((key) => key.startsWith('ph_')).map((key) => `cookie:${key}`),
  ];
}
const consentAdded = consent as typeof consent & {
  isPrivacyNoticeShown?: () => boolean;
  markPrivacyNoticeShown?: () => void;
  subscribeAnalyticsConsent?: (listener: () => void) => () => void;
  clearStoredAnalyticsIdentity?: () => void;
  resetPrivacyNoticeForTest?: () => void;
};

const TOKEN = 'privacy-test-only';
type SdkConfig = Parameters<PostHog['init']>[1];
/** Test-only: no remote config, flags or extension scripts, so a wrong start fails instead of hanging. */
const OFFLINE = { advanced_disable_flags: true, disable_external_dependency_loading: true, opt_out_useragent_filter: true };

// Every starter a test subscribes is unsubscribed before cleanup changes the
// opt-out: a leftover listener would start a real SDK after the test ended and
// keep the runner alive.
const unsubscribers: Array<() => void> = [];
const subscribe = (listener: () => void): void => {
  const unsubscribe = consentAdded.subscribeAnalyticsConsent?.(listener);
  if (unsubscribe) unsubscribers.push(unsubscribe);
};
const IDENTITY_KEY = `ph_${TOKEN}_posthog`;

/** Every way the SDK could reach the network from a browser. */
function watchNetwork(sdk?: PostHog): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalBeacon = navigator.sendBeacon;
  const originalOpen = XMLHttpRequest.prototype.open;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(`fetch ${String(input)}`);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  navigator.sendBeacon = ((url: string | URL) => { calls.push(`beacon ${String(url)}`); return true; }) as typeof navigator.sendBeacon;
  XMLHttpRequest.prototype.open = function open(this: XMLHttpRequest, method: string, url: string | URL) {
    calls.push(`xhr ${method} ${String(url)}`);
    // eslint-disable-next-line prefer-rest-params
    return originalOpen.apply(this, arguments as unknown as Parameters<typeof originalOpen>);
  } as typeof XMLHttpRequest.prototype.open;
  if (sdk) {
    sdk._send_request = sdk._send_retriable_request = (request: { url: string }) => { calls.push(`sdk ${request.url}`); };
  }
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
      navigator.sendBeacon = originalBeacon;
      XMLHttpRequest.prototype.open = originalOpen;
    },
  };
}

function storedIdentity(): string | null {
  return localStorage.getItem(IDENTITY_KEY);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  consentAdded.resetPrivacyNoticeForTest?.();
});
afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  consent.persistAnalyticsOptOut(false);
  localStorage.clear();
  consentAdded.resetPrivacyNoticeForTest?.();
});

describe('PostHog is not initialised before it may run', () => {
  it('an opted-out visitor: no init, no stored identifier, no network request', async () => {
    assert.ok(added.createAnalyticsStarter, 'createAnalyticsStarter is exported');
    const sdk = new PostHog();
    const network = watchNetwork(sdk);
    let inits = 0;
    try {
      consent.persistAnalyticsOptOut(true);
      const starter = added.createAnalyticsStarter({
        configured: true,
        init: () => { inits++; sdk.init(TOKEN, { ...added.analyticsInitConfig?.('https://posthog.invalid'), ...OFFLINE } as SdkConfig); },
        isOptedOut: consent.isAnalyticsOptedOut,
        isNoticeShown: () => true,
        subscribe,
      });
      starter.start();
      starter.attempt();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(inits, 0, 'PostHog init is never called');
      assert.equal(starter.isInitialised(), false);
      assert.equal(sdk.__loaded, false, 'the SDK stays unloaded');
      assert.deepEqual(network.calls, [], 'no request leaves the browser');
      assert.equal(storedIdentity(), null, 'no identifier is stored');
      assert.equal(document.cookie.includes(IDENTITY_KEY), false, 'no identifier cookie');
    } finally {
      network.restore();
      if (sdk.__loaded) { await sdk.shutdown(); sdk.sessionManager?.destroy(); }
    }
  });

  it('before the first-visit notice: nothing; once it is shown: PostHog starts', () => {
    assert.ok(added.createAnalyticsStarter);
    assert.ok(consentAdded.markPrivacyNoticeShown, 'markPrivacyNoticeShown is exported');
    assert.ok(consentAdded.isPrivacyNoticeShown, 'isPrivacyNoticeShown is exported');
    assert.ok(consentAdded.subscribeAnalyticsConsent, 'subscribeAnalyticsConsent is exported');
    let inits = 0;
    const starter = added.createAnalyticsStarter({
      configured: true,
      init: () => { inits++; },
      isOptedOut: consent.isAnalyticsOptedOut,
      isNoticeShown: consentAdded.isPrivacyNoticeShown,
      subscribe,
    });
    starter.start();
    assert.equal(inits, 0, 'not before the notice');
    consentAdded.markPrivacyNoticeShown();
    assert.equal(inits, 1, 'starts as the notice is shown');
    consentAdded.markPrivacyNoticeShown();
    assert.equal(inits, 1, 'once');
    assert.ok(localStorage.getItem(consent.PRIVACY_NOTICE_KEY), 'the notice is remembered');
  });

  it('opting back in starts PostHog without a reload; a build without a key never does', () => {
    assert.ok(added.createAnalyticsStarter, 'createAnalyticsStarter is exported');
    assert.ok(consentAdded.subscribeAnalyticsConsent, 'subscribeAnalyticsConsent is exported');
    let inits = 0;
    let unconfiguredInits = 0;
    consent.persistAnalyticsOptOut(true);
    const make = (configured: boolean, count: () => void) => added.createAnalyticsStarter!({
      configured,
      init: count,
      isOptedOut: consent.isAnalyticsOptedOut,
      isNoticeShown: () => true,
      subscribe,
    });
    make(true, () => { inits++; }).start();
    make(false, () => { unconfiguredInits++; }).start();
    assert.equal(inits, 0);
    analytics.setAnalyticsOptOut(false);
    assert.equal(inits, 1, 'opt-in starts it');
    assert.equal(unconfiguredInits, 0, 'no key, no PostHog');
  });

  it('opting out clears an identifier an earlier visit stored', () => {
    assert.ok(consentAdded.clearStoredAnalyticsIdentity);
    localStorage.setItem(IDENTITY_KEY, '{"distinct_id":"earlier"}');
    sessionStorage.setItem(IDENTITY_KEY, '{"$sesid":"earlier"}');
    sessionStorage.setItem(`ph_${TOKEN}_window_id`, '0190f0a0-0000-7000-8000-000000000000');
    sessionStorage.setItem(`ph_${TOKEN}_primary_window_exists`, 'true');
    document.cookie = `${IDENTITY_KEY}=earlier; path=/`;
    localStorage.setItem('ifc-lite:unrelated', 'kept');
    consentAdded.clearStoredAnalyticsIdentity();
    assert.equal(storedIdentity(), null);
    assert.deepEqual(postHogEntries(), [], 'no PostHog entry is left in local storage, session storage or cookies');
    assert.equal(localStorage.getItem('ifc-lite:unrelated'), 'kept');
  });
});

describe('what PostHog may record (installed SDK)', () => {
  it('switches off replay, autocapture, heatmaps, dead/rage clicks, web vitals and console logs in code', () => {
    assert.ok(added.analyticsInitConfig, 'analyticsInitConfig is exported');
    const config = added.analyticsInitConfig('https://eu.i.posthog.com');
    assert.equal(config.disable_session_recording, true);
    assert.equal(config.autocapture, false);
    assert.equal(config.rageclick, false);
    assert.equal(config.capture_dead_clicks, false);
    assert.equal(config.capture_heatmaps, false);
    assert.equal(config.capture_performance, false);
    assert.equal(config.capture_pageview, false);
    assert.equal(config.disable_surveys, true);
    assert.equal(config.disable_product_tours, true);
    assert.equal(config.disable_conversations, true);
    assert.equal(config.disable_web_experiments, true);
    assert.equal(config.opt_out_persistence_by_default, true);
    const extensions = config.__extensionClasses as Record<string, unknown> | undefined;
    assert.ok(extensions && Object.hasOwn(extensions, 'logs') && extensions.logs === undefined,
      'the console-log extension is left out, since the project setting could switch it on');
    assert.equal(config.before_send, analytics.beforeSend);
  });

  it('the SDK started with it records no replay or console logs, and deletes its identifier on opt-out', async () => {
    assert.ok(added.analyticsInitConfig);
    const sdk = new PostHog();
    const network = watchNetwork(sdk);
    try {
      sdk.init(TOKEN, {
        ...added.analyticsInitConfig('https://posthog.invalid'),
        ...OFFLINE, request_batching: false,
      } as SdkConfig);
      assert.equal(sdk.config.disable_session_recording, true);
      assert.equal(sdk.sessionRecording?.started ?? false, false, 'replay never starts');
      const enrolled = (sdk as unknown as { _extensions: unknown[] })._extensions;
      assert.equal(enrolled.includes(sdk.logs), false, 'the console-log extension is not enrolled');
      console.info('[test] opened /private/client.ifc');
      sdk.capture('command_executed', { command_id: 'test' });
      assert.ok(network.calls.length > 0, 'a consenting capture is sent');
      assert.equal(network.calls.some((call) => call.includes('/logs')), false, 'no log upload');
      assert.ok(storedIdentity(), 'a consenting visitor has an identifier');
      sdk.opt_out_capturing();
      assert.equal(storedIdentity(), null, 'opting out deletes it');
      const before = network.calls.length;
      sdk.capture('command_executed', { command_id: 'after' });
      assert.equal(network.calls.length, before, 'nothing is sent after the opt-out');
    } finally {
      network.restore();
      await sdk.shutdown();
      sdk.sessionManager?.destroy();
    }
  });
});

describe('events before the notice are held in memory, never stored or sent early', () => {
  it('sends held events once PostHog starts, with their original time', () => {
    assert.ok(added.createHeldAnalytics, 'createHeldAnalytics is exported');
    const held = added.createHeldAnalytics(100, true, (error) => error);
    const at = new Date('2026-11-28T08:00:00Z');
    held.client.capture('ifc_model_loaded', { schema: 'IFC4' }, { timestamp: at });
    held.client.capture('viewer_route', {});
    const crash = new Error('start-up crash');
    held.client.captureException(crash, { surface: 'boot' });
    assert.equal(held.size(), 3);
    const sent = recorder();
    held.flush(sent.target as never);
    assert.equal(sent.events.length, 3);
    assert.deepEqual([sent.events[0]!.name, sent.events[0]!.timestamp], ['ifc_model_loaded', at]);
    assert.ok(sent.events[1]!.timestamp instanceof Date, 'an event without a time keeps the time it happened');
    assert.equal(sent.events[2]!.error, crash);
    assert.equal(sent.events[2]!.properties?.held_before_notice, true);
    const heldAt = sent.events[2]!.properties?.held_at;
    assert.equal(typeof heldAt, 'string', 'error events carry their original time as held_at');
    assert.ok(Math.abs(Date.parse(heldAt as string) - Date.now()) < 60_000, 'held_at is the time of the failure');
    assert.equal(held.size(), 0, 'sent once');
  });

  it('an opt-out drops them; a host without analytics holds nothing; the buffer is capped', () => {
    assert.ok(added.createHeldAnalytics);
    const held = added.createHeldAnalytics(3, true, (error) => error);
    held.client.capture('a');
    held.clear();
    const sent = recorder();
    held.flush(sent.target as never);
    assert.equal(sent.events.length, 0, 'dropped on opt-out');
    for (let i = 0; i < 10; i++) held.client.capture(`e${i}`);
    assert.equal(held.size(), 3, 'only the first 3 are kept');
    held.stop();
    held.client.capture('after-stop');
    assert.equal(held.size(), 0, 'stop drops and holds nothing more');
    const keyless = added.createHeldAnalytics(3, false, (error) => error);
    keyless.client.capture('x');
    assert.equal(keyless.size(), 0, 'a build without a key holds nothing');
  });

  it('an opt-out in an open tab leaves no PostHog entry behind, even the ones PostHog keeps', async () => {
    assert.ok(added.analyticsInitConfig);
    const sdk = new PostHog();
    const network = watchNetwork(sdk);
    try {
      sdk.init(TOKEN, { ...added.analyticsInitConfig('https://posthog.invalid'), ...OFFLINE, request_batching: false } as SdkConfig);
      sdk.capture('command_executed', { command_id: 'test' });
      assert.ok(postHogEntries().some((entry) => entry.startsWith('session:')), 'the SDK wrote its session-storage keys');
      sdk.opt_out_capturing();
      analytics.setAnalyticsOptOut(true);
      sdk.capture('command_executed', { command_id: 'after' });
      assert.deepEqual(postHogEntries(), [], 'nothing left in local storage, session storage or cookies');
    } finally {
      network.restore();
      await sdk.shutdown();
      sdk.sessionManager?.destroy();
    }
  });

  it('copies properties when holding, so later changes by the caller are not sent', () => {
    assert.ok(added.createHeldAnalytics);
    const held = added.createHeldAnalytics(10, true, (error) => error);
    const properties: Record<string, unknown> = { schema: 'IFC4' };
    held.client.capture('ifc_model_loaded', properties);
    properties.schema = 'changed later';
    const sent = recorder();
    held.flush(sent.target as never);
    assert.equal(sent.events[0]!.properties?.schema, 'IFC4');
  });

  it('holds uncaught errors and unhandled rejections until PostHog takes over, then sends them as unhandled', () => {
    assert.ok(added.createHeldAnalytics && added.listenForUncaught, 'listenForUncaught is exported');
    const sentAsUnhandled: Array<{ error: unknown; properties: Record<string, unknown> }> = [];
    const held = added.createHeldAnalytics(2, true, (error) => error, (_target, error, properties) => { sentAsUnhandled.push({ error, properties }); });
    const page = new EventTarget();
    let optedOut = false;
    const stop = added.listenForUncaught(page, held.holdUncaught, () => optedOut);
    const crash = new Error('boot crash');
    page.dispatchEvent(Object.assign(new Event('error'), { error: crash, message: crash.message }));
    page.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'rejected at start-up' }));
    page.dispatchEvent(Object.assign(new Event('error'), { error: new Error('over the cap') }));
    assert.equal(held.size(), 2, 'capped');
    held.flush(recorder().target as never);
    assert.deepEqual(sentAsUnhandled.map((item) => item.error), [crash, 'rejected at start-up']);
    assert.equal(sentAsUnhandled[0]!.properties.held_before_notice, true);
    assert.equal(typeof sentAsUnhandled[0]!.properties.held_at, 'string');
    optedOut = true;
    page.dispatchEvent(Object.assign(new Event('error'), { error: new Error('opted out') }));
    assert.equal(held.size(), 0, 'nothing held for an opted-out visitor');
    optedOut = false;
    stop();
    page.dispatchEvent(Object.assign(new Event('error'), { error: new Error('after PostHog took over') }));
    assert.equal(held.size(), 0, 'no longer listening once PostHog runs, so nothing is captured twice');
  });

  it('an opt-out in another tab applies here: held events dropped and PostHog entries deleted', () => {
    localStorage.setItem(`ph_${TOKEN}_posthog`, '{"distinct_id":"x"}');
    sessionStorage.setItem(`ph_${TOKEN}_window_id`, 'w');
    localStorage.setItem('ifc-lite:analytics-opt-out', 'true');
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'ifc-lite:analytics-opt-out' }));
    assert.equal(consent.isAnalyticsOptedOut(), true, 'the other tab\'s opt-out is read');
    assert.deepEqual(postHogEntries(), [], 'and what PostHog stored is deleted here too');
  });
});
