/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The SDK `Transport` behind `MCPServer.handleMessage`.
 *
 * Our transports (stdio, HTTP, in-process, bridge tests) hand the server one
 * message and get the answer back as a return value, with everything else
 * (progress, log lines, list_changed) going out through the attached sink.
 * The SDK protocol layer instead writes every outgoing message to its
 * transport. This adapter joins the two: a response whose id we are waiting
 * on resolves that `deliver()` call, anything else goes to the sink.
 */

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';
import { JsonRpcErrorCode, type JsonRpcId, type JsonRpcMessage, type JsonRpcResponse } from '../protocol/index.js';
import { errorResponse, isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse } from '../protocol/jsonrpc.js';

export interface LoopbackSink {
  send(message: JsonRpcMessage): Promise<void> | void;
}

export class LoopbackTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private waiting = new Map<JsonRpcId, (response: JsonRpcResponse | null) => void>();
  /** A sink that threw synchronously on the last send; read once by `takeSyncFailure`. */
  private syncFailure: { error: unknown } | null = null;

  constructor(private readonly sink: () => LoopbackSink | null) {}

  async start(): Promise<void> { /* nothing to open */ }

  async close(): Promise<void> {
    this.settleAll();
    this.onclose?.();
  }

  /** Requests still waiting for an answer are answered with nothing. */
  settleAll(): void {
    for (const settle of this.waiting.values()) settle(null);
    this.waiting.clear();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (isJsonRpcResponse(message)) {
      // Every request arrives through deliver(), so a response nobody waits
      // for answers a cancelled request: the client asked us not to send it.
      const settle = message.id === null ? undefined : this.waiting.get(message.id);
      if (settle && message.id !== null) {
        this.waiting.delete(message.id);
        settle(message as JsonRpcResponse);
      }
      return Promise.resolve();
    }
    const sink = this.sink();
    if (!sink) return Promise.resolve();
    // Called synchronously so notifications leave in the order they were raised.
    try {
      return Promise.resolve(sink.send(message as JsonRpcMessage));
    } catch (error) {
      this.syncFailure = { error };
      return Promise.reject(error);
    }
  }

  /**
   * The error a sink threw synchronously during the send just made, if any.
   * The SDK sends from inside async functions, so a throwing sink otherwise
   * only surfaces as a rejection; progress reporting needs it at once.
   */
  takeSyncFailure(): { error: unknown } | null {
    const failure = this.syncFailure;
    this.syncFailure = null;
    return failure;
  }

  /** One inbound message; resolves with its response, or null for notifications and cancelled requests. */
  deliver(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    if (!this.onmessage) return Promise.resolve(null);
    if (isJsonRpcRequest(message)) {
      if (this.waiting.has(message.id)) {
        return Promise.resolve(errorResponse(message.id, JsonRpcErrorCode.InvalidRequest, `Request id ${String(message.id)} is already in flight`));
      }
      const answered = new Promise<JsonRpcResponse | null>((resolve) => this.waiting.set(message.id, resolve));
      this.onmessage(message as JSONRPCMessage);
      return answered;
    }
    this.onmessage(message as JSONRPCMessage);
    if (isJsonRpcNotification(message) && message.method === 'notifications/cancelled') {
      // The protocol layer sends no response for a cancelled request; stop waiting for one.
      const id = (message.params as { requestId?: JsonRpcId } | undefined)?.requestId;
      const settle = id === undefined ? undefined : this.waiting.get(id);
      if (settle && id !== undefined) {
        this.waiting.delete(id);
        settle(null);
      }
    }
    return Promise.resolve(null);
  }
}
