/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseModel, type ParseModelOptions, type ParsedModel } from '@ifc-lite/parser';
import { createBimContext, type BimContext } from '../context.js';
import { HeadlessBackend } from './backend.js';
import { UnsupportedOperationError, type HeadlessCapability, type HeadlessOperation } from './capabilities.js';
import type { HeadlessBackendOptions } from './options.js';

export class HeadlessSessionClosedError extends Error {
  readonly code = 'SESSION_CLOSED';
  constructor() { super('This headless model session is closed'); this.name = 'HeadlessSessionClosedError'; }
}
export interface OpenModelOptions extends ParseModelOptions {
  modelId?: string;
  modelName?: string;
  backend?: HeadlessBackendOptions;
}
export interface HeadlessModelSession extends ParsedModel {
  readonly bim: BimContext;
  readonly closed: boolean;
  capability(operation: HeadlessOperation): HeadlessCapability;
  /** Idempotent. Releases host preparation caches and refuses later backend calls. */
  close(): void;
}

/** Keep retained query builders and namespace references honest after close. */
function guardedBackend(backend: HeadlessBackend, modelId: string, assertOpen: () => void): HeadlessBackend {
  const checkRef = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ('modelId' in value && 'expressId' in value && value.modelId !== modelId)
      throw new TypeError(`Entity reference belongs to model '${String(value.modelId)}', expected '${modelId}'`);
  };
  const checkArgs = (args: unknown[]): void => {
    for (const arg of args) {
      checkRef(arg);
      if (!Array.isArray(arg)) continue;
      for (const item of arg) {
        checkRef(item);
        // Colour batches carry reference arrays one level below the argument.
        if (item && typeof item === 'object' && 'refs' in item && Array.isArray(item.refs))
          for (const ref of item.refs) checkRef(ref);
      }
    }
  };
  const cache = new WeakMap<object, object>();
  const guard = <T extends object>(value: T, prefix = ''): T => {
    const cached = cache.get(value);
    if (cached) return cached as T;
    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        const member: unknown = Reflect.get(target, key, receiver);
        if (typeof member === 'function') return (...args: unknown[]) => {
          assertOpen();
          const operation = (prefix ? `${prefix}.${String(key)}` : String(key)) as HeadlessOperation;
          const capability = backend.capability(operation);
          if (!capability.supported) throw new UnsupportedOperationError(operation, capability.reason ?? 'Unsupported operation');
          if (operation === 'query.entities') {
            const descriptor = args[0];
            if (descriptor && typeof descriptor === 'object' && 'modelId' in descriptor &&
                descriptor.modelId !== undefined && descriptor.modelId !== modelId)
              throw new TypeError(`Query scope belongs to model '${String(descriptor.modelId)}', expected '${modelId}'`);
          }
          checkArgs(args);
          return Reflect.apply(member, target, args);
        };
        if (member && typeof member === 'object') return guard(member, String(key));
        return member;
      },
    });
    cache.set(value, proxy);
    return proxy;
  };
  return guard(backend);
}

/** Open STEP/IFCZIP bytes for headless queries, mutations and export. No I/O or renderer is created. */
export async function openModel(input: Uint8Array | ArrayBuffer, options: OpenModelOptions = {}): Promise<HeadlessModelSession> {
  const modelId = options.modelId ?? 'model';
  if (!modelId.trim()) throw new TypeError('modelId must be a non-empty string');
  const parsed = await parseModel(input, options);
  let closed = false;
  const assertOpen = () => { if (closed) throw new HeadlessSessionClosedError(); };
  const provided = options.backend;
  const align = provided?.alignGeometry;
  const rooms = provided?.roomGeometry;
  // A native preparation already in flight must not commit after close.
  const backend = new HeadlessBackend(parsed.store, options.modelName ?? options.label ?? 'model.ifc', modelId, {
    ...provided,
    alignGeometry: align && (async (...args) => {
      assertOpen();
      const value = await align(...args);
      assertOpen();
      return value;
    }),
    roomGeometry: rooms && {
      clear: () => rooms.clear(),
      provide: async (...args) => {
        assertOpen();
        const value = await rooms.provide(...args);
        assertOpen();
        return value;
      },
    },
  });
  const bim = createBimContext({ backend: guardedBackend(backend, modelId, assertOpen) });
  return { ...parsed, bim, capability: operation => backend.capability(operation), get closed() { return closed; }, close() {
    if (closed) return;
    closed = true;
    backend.dispose();
  } };
}
