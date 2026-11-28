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

// Build a bounded snapshot before serializing it. JSON.stringify's built-in
// hook lookup would read an enumerable, non-callable toJSON a second time
// when visiting it as a property.
const DECODER_SOURCE = `(() => {
  const stringify = JSON.stringify;
  const apply = Reflect.apply;
  const functionSource = Function.prototype.call.bind(Function.prototype.toString);
  const isError = Error.isError;
  const isArray = Array.isArray;
  const keys = Object.keys;
  const emptyRecord = Object.create;
  const setPrototype = Object.setPrototypeOf;
  const unboxers = [
    Number.prototype.valueOf, String.prototype.valueOf,
    Boolean.prototype.valueOf, BigInt.prototype.valueOf,
  ];
  const trunc = Math.trunc;
  const WeakSet = globalThis.WeakSet;
  const has = Function.prototype.call.bind(WeakSet.prototype.has);
  const add = Function.prototype.call.bind(WeakSet.prototype.add);
  const remove = Function.prototype.call.bind(WeakSet.prototype.delete);
  const RangeError = globalThis.RangeError;
  const TypeError = globalThis.TypeError;
  const toString = String;
  const cycle = emptyRecord(null);
  const maxNodes = 1_000_000;
  return (value, maxDepth, describeError, allowCyclicConsoleValue) => {
    if (describeError) {
      const message = value != null ? value.message : undefined;
      const reason = message === undefined ? value : message;
      if (reason !== null && typeof reason === 'object') return '[object Object]';
      if (typeof reason === 'function') return '[function]';
      return toString(reason);
    }
    const ancestors = new WeakSet();
    let count = 0;

    function unbox(value) {
      for (let i = 0; i < unboxers.length; i++) {
        let primitive;
        try {
          primitive = apply(unboxers[i], value, []);
        } catch (error) {
          // The intrinsic rejected a receiver without its boxed primitive brand.
          continue;
        }
        // JSON uses the original coercion behavior for Number and String boxes.
        if (i === 0) return +value;
        if (i === 1) return toString(value);
        return primitive;
      }
      return value;
    }

    function snapshot(input, key, depth) {
      if (depth > maxDepth) throw new RangeError('Sandbox value exceeds decoding depth');
      if (++count > maxNodes) throw new RangeError('Sandbox value exceeds decoding size');
      const kind = typeof input;
      const hook = (input !== null && (kind === 'object' || kind === 'function' || kind === 'bigint'))
        ? input.toJSON : undefined;
      let projected = typeof hook === 'function' ? apply(hook, input, [key]) : input;
      const array = projected !== null && typeof projected === 'object' && isArray(projected);
      if (!array && projected !== null && typeof projected === 'object') projected = unbox(projected);
      if (typeof projected === 'bigint') throw new TypeError('Sandbox value contains a BigInt');
      if (typeof projected === 'function' || typeof projected === 'symbol') return undefined;
      if (projected === null || typeof projected !== 'object') return projected;

      if (has(ancestors, projected)) throw cycle;
      add(ancestors, projected);
      try {
        if (array) {
          const length = trunc(+projected.length);
          if (length > maxNodes - count) throw new RangeError('Sandbox value exceeds decoding size');
          const result = setPrototype([], null);
          for (let i = 0; i < length; i++) {
            result[i] = snapshot(projected[i], toString(i), depth + 1);
          }
          return result;
        }

        const result = emptyRecord(null);
        const fields = keys(projected);
        if (fields.length > maxNodes - count) throw new RangeError('Sandbox value exceeds decoding size');
        for (let i = 0; i < fields.length; i++) {
          const name = fields[i];
          const property = name === 'toJSON' && projected === input ? hook : projected[name];
          result[name] = snapshot(property, name, depth + 1);
        }
        // Keep the standard, usually non-enumerable diagnostics on a root Error.
        if (depth === 0 && projected === input && isError(input)) {
          if (!('name' in result)) result.name = snapshot(input.name, 'name', depth + 1);
          if (!('message' in result)) result.message = snapshot(input.message, 'message', depth + 1);
          if (!('stack' in result)) result.stack = snapshot(input.stack, 'stack', depth + 1);
        }
        return result;
      } finally {
        remove(ancestors, projected);
      }
    }

    try {
      const result = snapshot(value, '', 0);
      return stringify(result === undefined && typeof value === 'function' ? functionSource(value) : result);
    } catch (error) {
      if (error === cycle && allowCyclicConsoleValue) return stringify('[object Object]');
      throw error;
    }
  };
})()`;

export type DecodeValue = (handle: QuickJSHandle) => unknown;

export function createValueDecoder(vm: QuickJSContext, requestedDepth?: number) {
  const maxDepth = Number.isFinite(requestedDepth) && requestedDepth !== undefined
    ? Math.max(0, Math.min(MAX_DUMP_DEPTH, Math.floor(requestedDepth)))
    : MAX_DUMP_DEPTH;
  // Initialization runs against a fresh realm with trusted source.
  const decoder = vm.unwrapResult(vm.evalCode(DECODER_SOURCE));

  function read(handle: QuickJSHandle, depth: number, describeError: boolean, allowCyclicConsoleValue = false): string | undefined {
    const limit = vm.newNumber(depth);
    try {
      const result = vm.callFunction(
        decoder, vm.undefined, handle, limit,
        describeError ? vm.true : vm.false, allowCyclicConsoleValue ? vm.true : vm.false,
      );
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

  function decode(handle: QuickJSHandle, depth = maxDepth, allowCyclicConsoleValue = false): unknown {
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
          const decoded = decode(settled, depth - 1, allowCyclicConsoleValue);
          return state.type === 'rejected'
            ? { type: 'rejected', error: decoded }
            : { type: 'fulfilled', value: decoded };
        } finally {
          settled.dispose();
        }
      }
    }

    const json = read(handle, depth, false, allowCyclicConsoleValue);
    return json === undefined ? undefined : JSON.parse(json);
  }

  return {
    decode,
    decodeConsole: (handle: QuickJSHandle) => decode(handle, maxDepth, true),
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
