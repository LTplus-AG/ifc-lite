/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JSON-RPC 2.0 helpers used by every MCP transport.
 */

import {
  JSONRPC_VERSION,
  JsonRpcId,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
} from './types.js';

export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as JsonRpcMessage;
  return m.jsonrpc === JSONRPC_VERSION
    && typeof (m as JsonRpcRequest).method === 'string'
    && (m as JsonRpcRequest).id !== undefined;
}

export function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as JsonRpcMessage;
  return m.jsonrpc === JSONRPC_VERSION
    && typeof (m as JsonRpcNotification).method === 'string'
    && (m as JsonRpcRequest).id === undefined;
}

export function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as JsonRpcMessage;
  if (m.jsonrpc !== JSONRPC_VERSION) return false;
  return 'result' in m || 'error' in m;
}

export function successResponse<R>(id: JsonRpcId, result: R): JsonRpcSuccessResponse<R> {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const err: JsonRpcErrorObject = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error: err };
}

export function notification<P>(method: string, params?: P): JsonRpcNotification<P> {
  const note: JsonRpcNotification<P> = { jsonrpc: JSONRPC_VERSION, method };
  if (params !== undefined) note.params = params;
  return note;
}

export function parseMessage(text: string): JsonRpcMessage | null {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    if ((parsed as { jsonrpc?: string }).jsonrpc !== JSONRPC_VERSION) return null;
    return parsed as JsonRpcMessage;
  } catch {
    // Caller decides how to surface parse errors — most transports send
    // back a JSON-RPC ParseError response with id=null.
    return null;
  }
}
