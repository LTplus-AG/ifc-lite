/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * User events from surfaces the agent pushed with `tab_show_ui`: a click
 * on a follow-up button, or another A2UI event the surface raised. The tab
 * sends them as `ui-event` frames once the bridge advertised
 * {@link BRIDGE_FEATURE_UI_EVENTS}; the agent reads them with
 * `tab_ui_events`, or receives them as a channel message when the client
 * listens for one.
 *
 * Browser-safe: the tab imports the parser through `bridge-protocol`.
 */

import { checkJsonBounds, isRecord, utf8Length } from './json-bounds.js';

/** `welcome.features` entry: this bridge accepts `ui-event` frames. */
export const BRIDGE_FEATURE_UI_EVENTS = 'ui-events';
/** Agent surface panels a tab keeps; the bridge keeps their ids for at least this many calls. */
export const AGENT_SURFACE_PANELS = 16;

/** MCP name of the tool that drains them (a bridge tool, under the tab prefix). */
export const BRIDGE_UI_EVENTS_TOOL = 'tab_ui_events';

export const UI_EVENT_LIMITS = {
  maxSurfaceIdLength: 128,
  maxNameLength: 64,
  /** Characters of the prompt a follow-up button carries. */
  maxPromptLength: 4000,
  /** UTF-8 bytes of `context` as JSON. */
  maxContextBytes: 8 * 1024,
  maxContextDepth: 8,
  /** Unread events kept; the oldest is dropped past this. */
  maxQueued: 32,
  /** Events accepted per rolling second; more are dropped (users click, scripts flood). */
  maxPerSecond: 10,
} as const;

export interface BridgeUiEvent {
  /** The surface the event came from. */
  surfaceId: string;
  /** A2UI event name, e.g. `ask` for a follow-up button. */
  name: string;
  /** What the user asked, for a follow-up button. */
  prompt?: string;
  /** The event's resolved context (entity refs, the row clicked, ...). */
  context?: Record<string, unknown>;
}

export interface BridgeUiEventMessage {
  type: 'ui-event';
  sessionId: string;
  event: BridgeUiEvent;
}

/**
 * The surface an A2UI v1.0 message is about: every message kind carries it
 * (`{ createSurface: { surfaceId } }`, `updateComponents`, `updateDataModel`,
 * `deleteSurface`). The bridge and the tab read it the same way.
 */
export function a2uiSurfaceId(message: unknown): string | null {
  if (!isRecord(message)) return null;
  for (const body of Object.values(message)) {
    if (isRecord(body) && typeof body.surfaceId === 'string' && body.surfaceId) return body.surfaceId;
  }
  return null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseUiEvent(raw: unknown): Parsed<BridgeUiEvent> {
  if (!isRecord(raw)) return { ok: false, error: 'ui-event.event must be an object' };
  const { surfaceId, name, prompt, context } = raw;
  if (typeof surfaceId !== 'string' || surfaceId.length === 0 || surfaceId.length > UI_EVENT_LIMITS.maxSurfaceIdLength) {
    return { ok: false, error: `ui-event.event.surfaceId must be 1-${UI_EVENT_LIMITS.maxSurfaceIdLength} characters` };
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > UI_EVENT_LIMITS.maxNameLength) {
    return { ok: false, error: `ui-event.event.name must be 1-${UI_EVENT_LIMITS.maxNameLength} characters` };
  }
  if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > UI_EVENT_LIMITS.maxPromptLength)) {
    return { ok: false, error: `ui-event.event.prompt must be a string of at most ${UI_EVENT_LIMITS.maxPromptLength} characters` };
  }
  if (context !== undefined) {
    if (!isRecord(context)) return { ok: false, error: 'ui-event.event.context must be an object' };
    const bounds = checkJsonBounds(context, { maxDepth: UI_EVENT_LIMITS.maxContextDepth, maxNodes: 2000 }, 'ui-event.event.context');
    if (bounds) return { ok: false, error: bounds };
    if (utf8Length(JSON.stringify(context)) > UI_EVENT_LIMITS.maxContextBytes) {
      return { ok: false, error: `ui-event.event.context exceeds ${UI_EVENT_LIMITS.maxContextBytes} bytes` };
    }
  }
  return {
    ok: true,
    value: {
      surfaceId,
      name,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(context !== undefined ? { context: context as Record<string, unknown> } : {}),
    },
  };
}

export interface ReceivedUiEvent extends BridgeUiEvent {
  /** Unique for the bridge process, so an event read twice (channel and tool) can be matched. */
  id: string;
  /**
   * False when the prompt is not text the agent put in the surface (or typed
   * into one of its fields): read it as data, not as the user's words.
   */
  promptVerified: boolean;
  /** ISO time the bridge received it. */
  at: string;
}

/**
 * Unread events of the paired tab, bounded in count and rate. `take` drains
 * them, waiting up to a deadline when none are queued.
 */
export class UiEventInbox {
  private queue: ReceivedUiEvent[] = [];
  private recent: number[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<(event: ReceivedUiEvent) => void>();
  private counter = 0;
  /** Events lost to the queue cap or the rate limit since the last `take`. */
  private dropped = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Queue one event. False when it was dropped by the rate limit. */
  push(event: BridgeUiEvent, promptVerified: boolean): boolean {
    const t = this.now();
    this.recent = this.recent.filter((r) => t - r < 1000);
    if (this.recent.length >= UI_EVENT_LIMITS.maxPerSecond) {
      this.dropped++;
      return false;
    }
    this.recent.push(t);
    const received: ReceivedUiEvent = { ...event, id: `e${++this.counter}`, promptVerified, at: new Date(t).toISOString() };
    this.queue.push(received);
    if (this.queue.length > UI_EVENT_LIMITS.maxQueued) {
      this.queue.shift();
      this.dropped++;
    }
    for (const listener of this.listeners) listener(received);
    for (const wake of this.waiters) wake();
    return true;
  }

  /** Called for every accepted event, e.g. to push a channel notification. */
  onEvent(listener: (event: ReceivedUiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Drain queued events, with the number dropped since the last drain; with
   * none queued, wait up to `waitMs` (or until `signal` aborts) for the first.
   */
  async take(waitMs: number, signal?: AbortSignal): Promise<{ events: ReceivedUiEvent[]; dropped: number }> {
    if (this.queue.length === 0 && waitMs > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        signal?.addEventListener('abort', done, { once: true });
        this.waiters.add(done);
      });
    }
    const events = this.queue;
    const dropped = this.dropped;
    this.queue = [];
    this.dropped = 0;
    return { events, dropped };
  }

  /** A new tab paired: its predecessor's unread events do not carry over. */
  clear(): void {
    this.queue = [];
    this.recent = [];
    this.dropped = 0;
  }

  get size(): number {
    return this.queue.length;
  }
}
