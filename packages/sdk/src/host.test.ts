/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import { BimHost } from './host.js';
import { dispatchToBackend } from './types.js';
import type { BimBackend } from './types.js';

/**
 * Minimal mock backend: a real `query` namespace object plus a `subscribe`
 * stub. `dispatchToBackend`/`BimHost` only ever route through `hasOwnProperty`
 * lookups on `backend` and on the resolved namespace object, so this is
 * enough to exercise the dispatch gate without pulling in a full BimBackend.
 */
function createMockBackend() {
  const entities = vi.fn((..._args: unknown[]) => ['entity-1', 'entity-2']);
  const query = { entities };
  const backend = {
    query,
    subscribe: vi.fn(() => () => {}),
  } as unknown as BimBackend;
  return { backend, query };
}

describe('dispatchToBackend', () => {
  it('dispatches to an own method on the namespace', () => {
    const { backend, query } = createMockBackend();

    const result = dispatchToBackend(backend, 'query', 'entities', ['model-1']);

    expect(result).toEqual(['entity-1', 'entity-2']);
    expect(query.entities).toHaveBeenCalledWith('model-1');
  });

  it('rejects an unknown namespace', () => {
    const { backend } = createMockBackend();

    expect(() => dispatchToBackend(backend, 'nope', 'entities', [])).toThrow(
      "Unknown namespace 'nope'",
    );
  });

  // Security-critical: namespace/method come straight off the wire (see the
  // doc comment on dispatchToBackend). A member inherited from
  // Object.prototype must never be reachable through the dispatch gate --
  // that would let a caller invoke `toString`/`constructor`/etc. on an
  // internal namespace object. This is exactly what changing the
  // `Object.prototype.hasOwnProperty.call(ns, method)` check to `method in
  // ns` would break: `in` walks the prototype chain, so it can't tell an
  // own method from an inherited one.
  it('rejects an inherited method ("toString") instead of dispatching to it', () => {
    const { backend } = createMockBackend();

    expect(() => dispatchToBackend(backend, 'query', 'toString', [])).toThrow(
      "Unknown method 'query.toString'",
    );
  });

  it('rejects an inherited method ("constructor") instead of dispatching to it', () => {
    const { backend } = createMockBackend();

    expect(() => dispatchToBackend(backend, 'query', 'constructor', [])).toThrow(
      "Unknown method 'query.constructor'",
    );
  });
});

describe('BimHost.dispatch', () => {
  it('routes an SdkRequest for an own method to the backend and wraps the result', () => {
    const { backend, query } = createMockBackend();
    const host = new BimHost(backend);

    const response = host.dispatch({
      id: 'req-1',
      namespace: 'query',
      method: 'entities',
      args: ['model-1'],
    });

    expect(response).toEqual({ id: 'req-1', result: ['entity-1', 'entity-2'] });
    expect(query.entities).toHaveBeenCalledWith('model-1');
  });

  it('rejects a request for an inherited method and returns an error response, not a call', () => {
    const { backend, query } = createMockBackend();
    const host = new BimHost(backend);

    const response = host.dispatch({
      id: 'req-2',
      namespace: 'query',
      method: 'toString',
      args: [],
    });

    expect(response.id).toBe('req-2');
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toBe("Unknown method 'query.toString'");
    // The mocked own method must never have been touched by this request.
    expect(query.entities).not.toHaveBeenCalled();
  });
});
