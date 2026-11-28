/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What PostHog may record, and when it may start. Reached through
 * ./analytics.ts, which wires both to the SDK and the consent state.
 */

import type { PostHog, PostHogConfig } from 'posthog-js';
import { reportReplayPrivacy } from './analytics-report-privacy.js';

/**
 * The PostHog configuration. Everything that could record page content is
 * switched off here rather than left to the PostHog project's settings, so
 * the hosted viewer's behaviour can be read from this file:
 * - no session replay, autocapture, heatmaps, rage or dead clicks (these
 *   carry element text, which includes file, element and property names);
 * - no console log capture: the project setting can switch it on, and a
 *   client `captureConsoleLogs: false` does not override that, so the logs
 *   extension is left out of the SDK altogether;
 * - no web vitals, surveys, product tours, conversations or experiments;
 * - once a visitor opts out, PostHog removes its stored identifier.
 * ./analytics-start.test.ts runs it through the installed SDK.
 */
export function posthogInitConfig(apiHost: string, beforeSend: PostHogConfig['before_send']): Partial<PostHogConfig> {
  return {
    api_host: apiHost,
    // Events stay anonymous unless an explicit identify() opts a user in.
    person_profiles: 'identified_only',
    capture_pageview: false,
    capture_pageleave: true,
    autocapture: false,
    rageclick: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    disable_session_recording: true,
    // Kept although replay is off: if it were ever switched on, report
    // uploads and signed URLs still stay out of its network log.
    session_recording: reportReplayPrivacy,
    mask_all_text: true,
    mask_all_element_attributes: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    opt_out_persistence_by_default: true,
    __extensionClasses: { logs: undefined },
    // Strip any file name / model name / path / free text from every event
    // (current + future) before it leaves the browser, drop unactionable
    // third-party noise, and tag the geometry error family. See scrubEvent
    // in ./analytics-scrub.ts.
    before_send: beforeSend,
  };
}

/**
 * When PostHog may start: the build configures it, the host's feature set
 * asked for it (`start`), the visitor has not opted out, and the first-visit
 * notice has been shown. Until all four hold, the SDK is not initialised, so
 * it stores no identifier and makes no request. `attempt` is called again
 * whenever the opt-out or the notice changes.
 */
export function createAnalyticsStarter(deps: {
  configured: boolean;
  init: () => void;
  isOptedOut: () => boolean;
  isNoticeShown: () => boolean;
  subscribe: (listener: () => void) => void;
}): { start: () => void; attempt: () => void; isInitialised: () => boolean } {
  let requested = false;
  let initialised = false;
  const attempt = (): void => {
    if (!requested || initialised || !deps.configured) return;
    if (deps.isOptedOut() || !deps.isNoticeShown()) return;
    initialised = true;
    deps.init();
  };
  return {
    start: () => {
      if (requested) return;
      requested = true;
      deps.subscribe(attempt);
      attempt();
    },
    attempt,
    isInitialised: () => initialised,
  };
}

type AnalyticsClient = Pick<PostHog, 'capture' | 'captureException'>;
/** How the viewer sends a held uncaught error once PostHog runs: as unhandled, like PostHog's own autocapture. */
export type SendUncaught = (target: AnalyticsClient, error: unknown, properties: Record<string, unknown>) => void;

/**
 * Events captured before PostHog may start (the first-visit notice has not
 * been shown yet). They are held here in memory only: nothing is stored, sent
 * or given an identifier. `flush` sends them once PostHog has started. Usage
 * events keep their original time; PostHog has no time option for error
 * events, so those carry it as `held_at` and are marked `held_before_notice`.
 * `holdUncaught` queues an uncaught error or unhandled rejection, which
 * `listenForUncaught` feeds until PostHog takes over. `clear` drops everything
 * on an opt-out, and `stop` when this host sends no analytics at all. The
 * first `cap` are kept, so startup crashes and a fast deep-link load survive
 * while a runaway loop cannot grow memory.
 */
export function createHeldAnalytics(cap: number, holdFromStart: boolean, prepareError: (error: unknown) => unknown, sendUncaught?: SendUncaught): {
  client: AnalyticsClient;
  holdUncaught: (error: unknown) => void;
  flush: (target: AnalyticsClient) => void;
  clear: () => void;
  stop: () => void;
  size: () => number;
} {
  let holding = holdFromStart;
  let items: Array<(target: AnalyticsClient) => void> = [];
  const hold = (send: (target: AnalyticsClient) => void): void => {
    if (holding && items.length < cap) items.push(send);
  };
  const heldMarks = () => ({ held_before_notice: true, held_at: new Date().toISOString() });
  return {
    client: {
      capture: (event, properties, options) => {
        const timestamp = options?.timestamp ?? new Date();
        // Copied now: a caller may change its object before the notice.
        const copy = properties ? { ...properties } : properties;
        hold((target) => { target.capture(event, copy, { ...options, timestamp }); });
        return undefined;
      },
      captureException: (error, additionalProperties) => {
        // The stack is taken now, at the failure, not when the event is sent.
        const capturable = prepareError(error);
        const properties = { ...additionalProperties, ...heldMarks() };
        hold((target) => { target.captureException(capturable, properties); });
        return undefined;
      },
    },
    holdUncaught: (error) => {
      const properties = heldMarks();
      hold((target) => {
        if (sendUncaught) sendUncaught(target, error, properties);
        else target.captureException(error, properties);
      });
    },
    flush: (target) => { const out = items; items = []; for (const send of out) send(target); },
    clear: () => { items = []; },
    stop: () => { holding = false; items = []; },
    size: () => items.length,
  };
}

/**
 * Held uncaught errors go out as unhandled, like PostHog's own autocapture, so
 * the scrubber's uncaught-only noise gates apply to them too.
 */
export function sendAsUnhandled(sdk: Pick<PostHog, 'exceptions'>): SendUncaught {
  return (target, error, properties) => {
    const exceptions = sdk.exceptions;
    if (!exceptions) return void target.captureException(error, properties);
    exceptions.sendExceptionEvent({ ...exceptions.buildProperties(error, { handled: false }), ...properties });
  };
}

/**
 * Until PostHog runs (and its own exception autocapture with it), uncaught
 * errors and unhandled rejections go to `hold`. `isOptedOut` is checked per
 * error. Returns the function that removes both listeners, which the viewer
 * calls just before PostHog starts, so nothing is captured twice.
 */
export function listenForUncaught(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, hold: (error: unknown) => void, isOptedOut: () => boolean): () => void {
  const onError = (event: ErrorEvent): void => {
    if (isOptedOut()) return;
    hold(event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    if (isOptedOut()) return;
    hold(event.reason);
  };
  target.addEventListener('error', onError as EventListener);
  target.addEventListener('unhandledrejection', onRejection as EventListener);
  return () => {
    target.removeEventListener('error', onError as EventListener);
    target.removeEventListener('unhandledrejection', onRejection as EventListener);
  };
}
