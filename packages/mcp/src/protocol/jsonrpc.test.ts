/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  errorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  notification,
  parseMessage,
  successResponse,
} from './jsonrpc.js';
import { JSONRPC_VERSION, JsonRpcErrorCode } from './types.js';

describe('JSON-RPC helpers', () => {
  it('detects request shape', () => {
    expect(isJsonRpcRequest({ jsonrpc: JSONRPC_VERSION, id: 1, method: 'foo' })).toBe(true);
    expect(isJsonRpcRequest({ jsonrpc: JSONRPC_VERSION, method: 'foo' })).toBe(false);
    expect(isJsonRpcRequest(null)).toBe(false);
  });

  it('detects notification shape', () => {
    expect(isJsonRpcNotification({ jsonrpc: JSONRPC_VERSION, method: 'note' })).toBe(true);
    expect(isJsonRpcNotification({ jsonrpc: JSONRPC_VERSION, method: 'note', id: 1 })).toBe(false);
  });

  it('detects response shape', () => {
    expect(isJsonRpcResponse({ jsonrpc: JSONRPC_VERSION, id: 1, result: {} })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: JSONRPC_VERSION, id: 1, error: { code: 1, message: 'x' } })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: JSONRPC_VERSION, id: 1 })).toBe(false);
  });

  it('builds well-formed envelopes', () => {
    expect(successResponse(7, { ok: true })).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    expect(errorResponse(null, JsonRpcErrorCode.ParseError, 'bad'))
      .toEqual({ jsonrpc: '2.0', id: null, error: { code: JsonRpcErrorCode.ParseError, message: 'bad' } });
    expect(notification('progress', { p: 0.5 }))
      .toEqual({ jsonrpc: '2.0', method: 'progress', params: { p: 0.5 } });
  });

  it('parseMessage rejects non-2.0', () => {
    expect(parseMessage('{"jsonrpc":"1.0","method":"x"}')).toBeNull();
    expect(parseMessage('not-json')).toBeNull();
    expect(parseMessage('{"jsonrpc":"2.0","id":1,"method":"x"}'))
      .toMatchObject({ jsonrpc: '2.0', id: 1, method: 'x' });
  });
});
