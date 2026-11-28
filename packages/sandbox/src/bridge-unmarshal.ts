/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import type { EntityRef } from '@ifc-lite/sdk';
import { MAX_DUMP_DEPTH } from './types.js';

export type ArgType =
  | 'string'
  | 'number'
  | 'dump'
  | 'entityRefs' // missing becomes []; explicit null throws
  | 'entityRefs?' // missing or nullish becomes undefined (export.ifc compatibility)
  | 'entityRefsUndefined?' // missing/undefined becomes undefined; null throws (#4789)
  | '...strings';

// Capture intrinsics before running user code. The replacer runs before
// stringify descends into each value, including values returned by toJSON.
// Track the current depth of each holder; shared objects are visited once per
// occurrence at that occurrence's depth. The serializer rejects cycles.
const DECODER_SOURCE = `(() => {
  const stringify = JSON.stringify;
  const functionSource = Function.prototype.call.bind(Function.prototype.toString);
  const isError = Error.isError;
  const keys = Object.keys;
  const define = Object.defineProperty;
  const emptyRecord = Object.create;
  const getDepth = Function.prototype.call.bind(WeakMap.prototype.get);
  const setDepth = Function.prototype.call.bind(WeakMap.prototype.set);
  const DepthMap = WeakMap;
  const RangeError = globalThis.RangeError;
  const toString = String;
  const maxNodes = 1_000_000;
  return (value, maxDepth, describeError) => {
    if (describeError) {
      const message = value != null ? value.message : undefined;
      const reason = message === undefined ? value : message;
      if (reason !== null && typeof reason === 'object') return '[object Object]';
      if (typeof reason === 'function') return '[function]';
      return toString(reason);
    }
    const depths = new DepthMap();
    let count = 0;
    const json = stringify(value, function (_key, child) {
      const depth = (getDepth(depths, this) ?? -1) + 1;
      if (depth > maxDepth) throw new RangeError('Sandbox value exceeds decoding depth');
      if (++count > maxNodes) throw new RangeError('Sandbox value exceeds decoding size');
      // Dump includes the standard diagnostics on a top-level Error.
      if (depth === 0 && child === value && isError(value)) {
        const fields = keys(value);
        if (fields.length > maxNodes) throw new RangeError('Sandbox value exceeds decoding size');
        const record = emptyRecord(null);
        for (let i = 0; i < fields.length; i++) {
          const key = fields[i];
          define(record, key, { __proto__: null, enumerable: true, configurable: true, get: () => value[key] });
        }
        const diagnostics = ['name', 'message', 'stack'];
        for (let i = 0; i < diagnostics.length; i++) {
          const key = diagnostics[i];
          define(record, key, { __proto__: null, enumerable: true, get: () => value[key] });
        }
        child = record;
      }
      if (child !== null && typeof child === 'object') setDepth(depths, child, depth);
      return child;
    });
    return json === undefined && typeof value === 'function' ? stringify(functionSource(value)) : json;
  };
})()`;

export type DecodeValue = (handle: QuickJSHandle) => unknown;

export function createValueDecoder(vm: QuickJSContext, requestedDepth?: number) {
  const maxDepth = Number.isFinite(requestedDepth) && requestedDepth !== undefined
    ? Math.max(0, Math.min(MAX_DUMP_DEPTH, Math.floor(requestedDepth)))
    : MAX_DUMP_DEPTH;
  // Initialization runs against a fresh realm with trusted source.
  const decoder = vm.unwrapResult(vm.evalCode(DECODER_SOURCE));

  function read(handle: QuickJSHandle, depth: number, describeError: boolean): string | undefined {
    const limit = vm.newNumber(depth);
    try {
      const result = vm.callFunction(decoder, vm.undefined, handle, limit, describeError ? vm.true : vm.false);
      if (result.error) {
        result.error.dispose();
        throw new Error(`Sandbox value could not be decoded (depth limit ${maxDepth})`);
      }
      try {
        return vm.typeof(result.value) === 'undefined' ? undefined : vm.getString(result.value);
      } finally {
        result.value.dispose();
      }
    } finally {
      limit.dispose();
    }
  }

  function decode(handle: QuickJSHandle, depth = maxDepth): unknown {
    const type = vm.typeof(handle);
    switch (type) {
      case 'undefined': return undefined;
      case 'string': return vm.getString(handle);
      case 'number': return vm.getNumber(handle);
      case 'bigint': return vm.getBigInt(handle);
      case 'symbol': return vm.getSymbol(handle);
    }

    if (type === 'object') {
      const state = vm.getPromiseState(handle);
      if (state.type === 'pending') return { type: 'pending' };
      if (state.type === 'rejected' || !state.notAPromise) {
        const settled = state.type === 'rejected' ? state.error : state.value;
        try {
          if (depth === 0) throw new Error(`Sandbox value exceeds decoding depth (limit ${maxDepth})`);
          const decoded = decode(settled, depth - 1);
          return state.type === 'rejected'
            ? { type: 'rejected', error: decoded }
            : { type: 'fulfilled', value: decoded };
        } finally {
          settled.dispose();
        }
      }
    }

    const json = read(handle, depth, false);
    return json === undefined ? undefined : JSON.parse(json);
  }

  return {
    decode,
    describeError: (handle: QuickJSHandle) => read(handle, 0, true) ?? 'undefined',
    dispose: () => decoder.dispose(),
  };
}

/** Unmarshal QuickJS handles to native JS values based on arg schema. */
export function unmarshalArgs(
  vm: QuickJSContext,
  handles: QuickJSHandle[],
  argTypes: ArgType[],
  decode: DecodeValue,
): unknown[] {
  const result: unknown[] = [];
  for (let i = 0; i < argTypes.length; i++) {
    switch (argTypes[i]) {
      case 'string':
        result.push(handles[i] ? vm.getString(handles[i]) : undefined);
        break;
      case 'number':
        result.push(handles[i] ? vm.getNumber(handles[i]) : undefined);
        break;
      case 'dump':
        result.push(handles[i] ? decode(handles[i]) : undefined);
        break;
      case 'entityRefs': case 'entityRefs?': case 'entityRefsUndefined?': {
        const optional = argTypes[i] === 'entityRefs?';
        const undefinedOnly = argTypes[i] === 'entityRefsUndefined?';
        const raw = handles[i]
          ? decode(handles[i]) as Array<{ ref?: EntityRef } & EntityRef> | null | undefined
          : (optional || undefinedOnly ? undefined : []);
        result.push(
          (optional && raw == null) || (undefinedOnly && raw === undefined)
            ? undefined
            : (raw as Array<{ ref?: EntityRef } & EntityRef>).map(r => r.ref ?? r),
        );
        break;
      }
      case '...strings': {
        const rest: string[] = [];
        for (let j = i; j < handles.length; j++) {
          if (handles[j]) rest.push(vm.getString(handles[j]));
        }
        result.push(rest);
        return result;
      }
    }
  }
  return result;
}
