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

import { isJSONRPCRequest, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/server';
import { JsonRpcErrorCode, type JsonRpcId, type JsonRpcMessage, type JsonRpcResponse } from '../protocol/index.js';
import { errorResponse, isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse } from '../protocol/jsonrpc.js';
import { describeThrown } from '../errors.js';

export interface LoopbackSink {
  send(message: JsonRpcMessage): Promise<void> | void;
}

export class LoopbackTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private waiting = new Map<JsonRpcId, (response: JsonRpcResponse | null) => void>();
  /** The error the sink threw synchronously during the latest send, if it did. */
  private syncFailure: { error: unknown } | null = null;
  /** Id of the initialize request whose response has not gone out yet. */
  private pendingInitialize: JsonRpcId | undefined;
  /** Whether a response to `initialize` has reached the client. */
  handshakeSent = false;

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
    this.syncFailure = null;
    if (isJsonRpcResponse(message)) {
      // Every request arrives through deliver(), so a response nobody waits
      // for answers a cancelled request: the client asked us not to send it.
      const settle = this.take(message.id);
      if (settle && message.id === this.pendingInitialize) {
        this.pendingInitialize = undefined;
        if ('result' in message) this.handshakeSent = true;
      }
      settle?.(message as JsonRpcResponse);
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

  /** Stop waiting for a response to `id`; returns its resolver, if it was waiting. */
  private take(id: JsonRpcId | null | undefined): ((response: JsonRpcResponse | null) => void) | undefined {
    if (id === null || id === undefined) return undefined;
    const settle = this.waiting.get(id);
    this.waiting.delete(id);
    return settle;
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
      // The SDK drops a request its strict envelope schema refuses (null or
      // fractional id, array params, extra members) without answering it.
      if (!isJSONRPCRequest(message)) {
        const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
        return Promise.resolve(errorResponse(id, JsonRpcErrorCode.InvalidRequest, 'Invalid JSON-RPC request'));
      }
      if (this.waiting.has(message.id)) {
        return Promise.resolve(errorResponse(message.id, JsonRpcErrorCode.InvalidRequest, `Request id ${String(message.id)} is already in flight`));
      }
      const answered = new Promise<JsonRpcResponse | null>((resolve) => this.waiting.set(message.id, resolve));
      if (message.method === 'initialize') this.pendingInitialize = message.id;
      try {
        this.onmessage(message as JSONRPCMessage);
      } catch (err) {
        this.take(message.id);
        return Promise.resolve(errorResponse(message.id, JsonRpcErrorCode.InternalError, describeThrown(err)));
      }
      return answered;
    }
    this.onmessage(message as JSONRPCMessage);
    if (isJsonRpcNotification(message) && message.method === 'notifications/cancelled') {
      // The protocol layer sends no response for a cancelled request; stop waiting for one.
      this.take((message.params as { requestId?: JsonRpcId } | undefined)?.requestId)?.(null);
    }
    return Promise.resolve(null);
  }
}
