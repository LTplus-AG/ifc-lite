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
import { errorResponse, isJsonRpcRequest, isJsonRpcResponse } from '../protocol/jsonrpc.js';
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
  /** Initialize requests not answered yet. */
  private pendingInitialize = new Set<JsonRpcId>();
  private sentHandshake = false;
  /** Callers waiting for every pending initialize to be answered. */
  private initializeWaiters: Array<() => void> = [];
  /** Whether an initialize result has gone out; requests and notifications wait for it. */
  get handshakeSent(): boolean { return this.sentHandshake; }

  /**
   * Resolves once no initialize is pending, so a request pipelined behind one
   * learns whether it succeeded (clients may pipeline; a refused or cancelled
   * initialize leaves the connection uninitialized).
   */
  initializeSettled(): Promise<void> {
    if (this.pendingInitialize.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.initializeWaiters.push(resolve));
  }

  private flushInitializeWaiters(): void {
    const waiters = this.initializeWaiters;
    this.initializeWaiters = [];
    for (const resolve of waiters) resolve();
  }

  constructor(private readonly sink: () => LoopbackSink | null) {}

  async start(): Promise<void> { /* nothing to open */ }

  async close(): Promise<void> {
    this.settleAll();
    this.onclose?.();
  }

  /** The connection closed: requests still waiting get an error, so `null` keeps meaning "cancelled". */
  settleAll(): void {
    for (const [id, settle] of this.waiting) settle(errorResponse(id, JsonRpcErrorCode.InternalError, 'The connection closed before the request was answered'));
    this.waiting.clear();
    this.pendingInitialize.clear();
    this.flushInitializeWaiters();
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.syncFailure = null;
    if (isJsonRpcResponse(message)) {
      // Every request arrives through deliver(), so a response nobody waits
      // for answers an abandoned request: the client asked us not to send it.
      if ('result' in message && message.id !== null && this.pendingInitialize.has(message.id)) this.sentHandshake = true;
      this.take(message.id)?.(message as JsonRpcResponse);
      return Promise.resolve();
    }
    // No server-originated message may precede the initialize result.
    if (!this.sentHandshake) return Promise.resolve();
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
   * The protocol layer aborted request `id` and will send no response: free
   * the id for reuse now; the returned callback answers the caller with
   * nothing when it is called (after the aborted handler has unwound).
   */
  release(id: JsonRpcId): (() => void) | undefined {
    const settle = this.take(id);
    return settle && (() => settle(null));
  }

  /** Stop waiting for a response to `id`; returns its resolver, if it was waiting. */
  private take(id: JsonRpcId | null | undefined): ((response: JsonRpcResponse | null) => void) | undefined {
    if (id === null || id === undefined) return undefined;
    const settle = this.waiting.get(id);
    this.waiting.delete(id);
    if (this.pendingInitialize.delete(id) && this.pendingInitialize.size === 0) this.flushInitializeWaiters();
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

  /** One inbound message; resolves with its response, or null for notifications and abandoned requests. */
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
        // id null: the client must not match this to the live request with that id.
        return Promise.resolve(errorResponse(null, JsonRpcErrorCode.InvalidRequest, `Request id ${String(message.id)} is already in flight`));
      }
      const answered = new Promise<JsonRpcResponse | null>((resolve) => this.waiting.set(message.id, resolve));
      if (message.method === 'initialize') this.pendingInitialize.add(message.id);
      try {
        this.onmessage(message as JSONRPCMessage);
      } catch (err) {
        this.take(message.id);
        return Promise.resolve(errorResponse(message.id, JsonRpcErrorCode.InternalError, describeThrown(err)));
      }
      return answered;
    }
    // The server sends the client no requests, so a client response answers nothing.
    if (isJsonRpcResponse(message)) return Promise.resolve(null);
    this.onmessage(message as JSONRPCMessage);
    return Promise.resolve(null);
  }
}
