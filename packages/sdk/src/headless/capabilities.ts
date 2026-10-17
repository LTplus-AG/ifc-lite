/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BimBackend } from '../types.js';
import type { HeadlessBackendOptions } from './options.js';

type Namespace = Exclude<keyof BimBackend, 'subscribe'>;
export type HeadlessOperation = 'subscribe' | {
  [K in Namespace]-?: `${K}.${Extract<keyof NonNullable<BimBackend[K]>, string>}`
}[Namespace];
export interface HeadlessCapability {
  readonly operation: HeadlessOperation;
  readonly supported: boolean;
  readonly reason?: string;
}
export class UnsupportedOperationError extends Error {
  readonly code = 'UNSUPPORTED_OPERATION';
  constructor(readonly operation: HeadlessOperation, readonly reason: string, message = `${operation}: ${reason}`) {
    super(message);
    this.name = 'UnsupportedOperationError';
  }
}
const refusals = new WeakMap<Function, HeadlessCapability>();
export function unsupportedOperation(operation: HeadlessOperation, message: string): (...args: unknown[]) => never {
  const reason = 'This headless backend does not implement this authoring operation';
  const capability = { operation, supported: false, reason };
  const refuse = () => { throw new UnsupportedOperationError(operation, reason, message); };
  refusals.set(refuse, capability);
  return refuse;
}

/** Supported means implemented/configured, not that every input or runtime will succeed. */
export function describeHeadlessOperation(backend: BimBackend, operation: HeadlessOperation,
  options: HeadlessBackendOptions, viewerAttached: boolean): HeadlessCapability {
  const unavailable = (reason: string): HeadlessCapability => ({ operation, supported: false, reason });
  if (operation === 'subscribe') return unavailable('This headless backend has no event source');
  const [namespace, method] = operation.split('.');
  const object: unknown = Reflect.get(backend, namespace);
  if (!object || typeof object !== 'object') return unavailable('This headless backend does not implement the namespace');
  const fn: unknown = Object.hasOwn(object, method) ? Reflect.get(object, method) : undefined;
  if (typeof fn !== 'function') return unavailable('This headless backend does not implement the method');
  const refusal = refusals.get(fn);
  if (refusal) return { ...refusal, operation };
  if ((namespace === 'viewer' || namespace === 'visibility') && !viewerAttached)
    return unavailable('Attach a viewer adapter to use viewer operations');
  if (['spatial', 'lens', 'files'].includes(namespace)) return unavailable('This headless backend has no provider for this namespace');
  if (operation === 'model.loadIfc') return unavailable('Open another model session to load a new model');
  if (operation === 'export.download') return unavailable('Write the export bytes using your application file API');
  if (operation === 'store.alignElements' && !options.alignGeometry)
    return unavailable('Align requires a host geometry provider');
  if (operation === 'store.roomCommand' && !options.roomGeometry)
    return unavailable('Room requires a host geometry provider');
  return { operation, supported: true };
}
