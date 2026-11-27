/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModelRegistry } from './context.js';

/** Serialize source registration and file replacement within a model session. */
const queues = new WeakMap<ModelRegistry, Promise<void>>();

export async function withSourceWriteLock<T>(registry: ModelRegistry, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(registry);
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  queues.set(registry, next);
  try {
    await previous;
    return await operation();
  } finally {
    release();
    if (queues.get(registry) === next) queues.delete(registry);
  }
}
