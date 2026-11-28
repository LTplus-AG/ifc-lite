/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import type { EntityRef } from '@ifc-lite/sdk';

export type ArgType =
  | 'string'
  | 'number'
  | 'dump'
  | 'entityRefs' // missing becomes []; explicit null throws
  | 'entityRefs?' // missing or nullish becomes undefined (export.ifc compatibility)
  | 'entityRefsUndefined?' // missing/undefined becomes undefined; null throws (#4789)
  | '...strings';

function readDumpedArg(vm: QuickJSContext, handle: QuickJSHandle, jsonBridgeArguments: boolean): unknown {
  if (!jsonBridgeArguments) return vm.dump(handle);
  const type = vm.typeof(handle);
  if (type === 'string') return JSON.parse(vm.getString(handle)) as unknown;
  if (type === 'object' || type === 'function') throw new TypeError('Expected a pre-serialized bridge argument');
  return vm.dump(handle);
}

/** Unmarshal QuickJS handles to native JS values based on arg schema. */
export function unmarshalArgs(vm: QuickJSContext, handles: QuickJSHandle[], argTypes: ArgType[], jsonBridgeArguments = false): unknown[] {
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
        result.push(handles[i] ? readDumpedArg(vm, handles[i], jsonBridgeArguments) : undefined);
        break;
      case 'entityRefs': case 'entityRefs?': case 'entityRefsUndefined?': {
        const optional = argTypes[i] === 'entityRefs?';
        const undefinedOnly = argTypes[i] === 'entityRefsUndefined?';
        const raw = handles[i]
          ? readDumpedArg(vm, handles[i], jsonBridgeArguments) as Array<{ ref?: EntityRef } & EntityRef> | null | undefined
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
