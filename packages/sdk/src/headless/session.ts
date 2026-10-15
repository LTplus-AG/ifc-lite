/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseModel, type ParseModelOptions, type ParsedModel } from '@ifc-lite/parser';
import { createBimContext, type BimContext } from '../context.js';
import type { BimBackend } from '../types.js';
import { HeadlessBackend } from './backend.js';
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
  /** Idempotent. Releases host preparation caches and refuses later backend calls. */
  close(): void;
}

/** Keep retained query builders and namespace references honest after close. */
function guardedBackend(backend: BimBackend, assertOpen: () => void): BimBackend {
  const cache = new WeakMap<object, object>();
  const guard = <T extends object>(value: T): T => {
    const cached = cache.get(value);
    if (cached) return cached as T;
    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        const member: unknown = Reflect.get(target, key, receiver);
        if (typeof member === 'function') return (...args: unknown[]) => {
          assertOpen();
          return Reflect.apply(member, target, args);
        };
        if (member && typeof member === 'object') return guard(member);
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
  const parsed = await parseModel(input, options);
  let closed = false;
  const assertOpen = () => { if (closed) throw new HeadlessSessionClosedError(); };
  const provided = options.backend;
  const align = provided?.alignGeometry;
  const rooms = provided?.roomGeometry;
  // A native preparation already in flight must not commit after close.
  const backend = new HeadlessBackend(parsed.store, options.modelName ?? options.label ?? 'model.ifc', options.modelId ?? 'model', {
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
  const bim = createBimContext({ backend: guardedBackend(backend, assertOpen) });
  return { ...parsed, bim, get closed() { return closed; }, close() {
    if (closed) return;
    closed = true;
    backend.dispose();
  } };
}
