/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import {
  isWasmRuntimeTrap,
  isWasmRuntimeUnrecoverableError,
  notifyWasmRuntimeUnrecoverable,
  wasmRuntimeUnrecoverableError,
  WASM_RUNTIME_UNRECOVERABLE_CODE,
  WASM_RUNTIME_UNRECOVERABLE_EVENT,
} from './wasm-runtime-trap.js';

const g = globalThis as unknown as { dispatchEvent?: (e: Event) => boolean };
const originalDispatch = g.dispatchEvent;

afterEach(() => {
  if (originalDispatch) g.dispatchEvent = originalDispatch;
  else delete g.dispatchEvent;
});

describe('isWasmRuntimeTrap', () => {
  it('matches a same-realm WebAssembly.RuntimeError', () => {
    expect(isWasmRuntimeTrap(new WebAssembly.RuntimeError('unreachable'))).toBe(true);
  });

  it('matches a cross-realm trap by name (structured-cloned out of a Worker)', () => {
    // A trap re-raised from another realm fails `instanceof` because that realm
    // has its own `WebAssembly.RuntimeError` constructor; `.name` survives.
    const crossRealm = new Error('unreachable');
    crossRealm.name = 'RuntimeError';
    expect(isWasmRuntimeTrap(crossRealm)).toBe(true);
  });

  it('does not match ordinary errors, strings or null', () => {
    expect(isWasmRuntimeTrap(new Error('NO_RENDER_GEOMETRY'))).toBe(false);
    expect(isWasmRuntimeTrap(new TypeError('boom'))).toBe(false);
    expect(isWasmRuntimeTrap('RuntimeError: unreachable')).toBe(false);
    expect(isWasmRuntimeTrap(null)).toBe(false);
    expect(isWasmRuntimeTrap(undefined)).toBe(false);
  });
});

describe('wasmRuntimeUnrecoverableError', () => {
  it('is a fresh object every time, so its stack is the real throw site', () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const a = wasmRuntimeUnrecoverableError(trap, 'init');
    const b = wasmRuntimeUnrecoverableError(trap, 'init');
    expect(a).not.toBe(b);
  });

  it('keeps the underlying trap in the message tail and as cause', () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const err = wasmRuntimeUnrecoverableError(trap, 'init');
    expect(err.message).toContain(WASM_RUNTIME_UNRECOVERABLE_CODE);
    expect(err.message).toContain('unreachable');
    expect(err.cause).toBe(trap);
    expect(isWasmRuntimeUnrecoverableError(err)).toBe(true);
  });

  it('classifies from the message alone (analytics / postMessage round trip)', () => {
    const err = wasmRuntimeUnrecoverableError(new WebAssembly.RuntimeError('unreachable'), 'init');
    expect(isWasmRuntimeUnrecoverableError(err.message)).toBe(true);
    expect(isWasmRuntimeUnrecoverableError('RuntimeError: unreachable')).toBe(false);
  });
});

describe('notifyWasmRuntimeUnrecoverable', () => {
  it('dispatches the event with the message when the host has a DOM dispatcher', () => {
    const seen: CustomEvent[] = [];
    g.dispatchEvent = (e: Event) => {
      seen.push(e as CustomEvent);
      return true;
    };

    notifyWasmRuntimeUnrecoverable(
      wasmRuntimeUnrecoverableError(new WebAssembly.RuntimeError('unreachable'), 'init'),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe(WASM_RUNTIME_UNRECOVERABLE_EVENT);
    expect(seen[0].detail.message).toContain(WASM_RUNTIME_UNRECOVERABLE_CODE);
  });

  it('is a silent no-op in a non-DOM host (CLI / MCP under Node)', () => {
    delete g.dispatchEvent;
    expect(() => notifyWasmRuntimeUnrecoverable(new Error('boom'))).not.toThrow();
  });
});
