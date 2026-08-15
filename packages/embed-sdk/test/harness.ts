/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test harness for the embed SDK.
 *
 * The SDK talks to a real cross-origin iframe. Under happy-dom the iframe never
 * navigates (see vitest.config.ts), so we install our own `contentWindow` whose
 * `postMessage` records everything the SDK sends, and we synthesise inbound
 * `MessageEvent`s with full control over `origin` and `source`.
 */

import { EMBED_SOURCE, PROTOCOL_VERSION } from '@ifc-lite/embed-protocol';
import { IFCLiteEmbed, type EmbedOptions } from '../src/index.js';

export const DEFAULT_ORIGIN = 'https://embed.ifclite.com';

export interface PostedMessage {
  msg: Record<string, unknown>;
  targetOrigin: string;
  transfer: unknown;
}

export interface InboundOptions {
  origin?: string;
  /** Pass `null` to simulate a message from a window that is not our iframe. */
  source?: unknown;
}

export interface Harness {
  container: HTMLDivElement;
  iframe: HTMLIFrameElement;
  /** Everything the SDK has posted into the iframe, oldest first. */
  posted: PostedMessage[];
  /** The fake `contentWindow` the SDK posts into. */
  frameWindow: unknown;
  /** Promise returned by `IFCLiteEmbed.create` — resolves after the handshake. */
  created: Promise<IFCLiteEmbed>;
  /** Dispatch an inbound message event at the host window. */
  inbound(data: unknown, opts?: InboundOptions): void;
  /** Dispatch a well-formed embed envelope. */
  emit(type: string, data?: unknown, extra?: Record<string, unknown>, opts?: InboundOptions): void;
  /** Drive READY → INIT → INIT_ACK and return the ready instance. */
  handshake(): Promise<IFCLiteEmbed>;
  /** The most recently posted message. */
  last(): PostedMessage;
  cleanup(): void;
}

export function mount(opts: Partial<EmbedOptions> = {}): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);

  // `create` is async but runs the constructor synchronously before its first
  // await, so the iframe exists as soon as the call returns.
  const created = IFCLiteEmbed.create({ container, ...opts } as EmbedOptions);
  // Swallow the rejection here so a deliberately-timed-out handshake does not
  // surface as an unhandled rejection; tests still assert on `created`.
  created.catch(() => {});

  // The caller may have overridden `container` (e.g. with a CSS selector), so
  // look the iframe up in whichever element the SDK actually mounted into.
  const mountedInto = typeof opts.container === 'string'
    ? document.querySelector(opts.container)
    : (opts.container ?? container);
  const iframe = mountedInto?.querySelector('iframe');
  if (!iframe) throw new Error('harness: SDK did not create an iframe');

  const posted: PostedMessage[] = [];
  const frameWindow = {
    postMessage(msg: Record<string, unknown>, targetOrigin: string, transfer: unknown) {
      posted.push({ msg, targetOrigin, transfer });
    },
  };
  Object.defineProperty(iframe, 'contentWindow', { value: frameWindow, configurable: true });

  const expectedOrigin = new URL(opts.origin ?? DEFAULT_ORIGIN).origin;

  const inbound = (data: unknown, o: InboundOptions = {}) => {
    window.dispatchEvent(new MessageEvent('message', {
      data,
      origin: o.origin ?? expectedOrigin,
      source: ('source' in o ? o.source : frameWindow) as MessageEventSource,
    }));
  };

  const emit = (
    type: string,
    data?: unknown,
    extra: Record<string, unknown> = {},
    o: InboundOptions = {},
  ) => {
    inbound({ source: EMBED_SOURCE, version: PROTOCOL_VERSION, type, data, ...extra }, o);
  };

  return {
    container,
    iframe,
    posted,
    frameWindow,
    created,
    inbound,
    emit,
    last: () => {
      if (posted.length === 0) throw new Error('harness: nothing has been posted');
      return posted[posted.length - 1]!;
    },
    async handshake() {
      emit('READY', { version: PROTOCOL_VERSION });
      emit('INIT_ACK');
      return created;
    },
    cleanup() {
      container.remove();
    },
  };
}
