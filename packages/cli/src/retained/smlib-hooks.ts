// SPDX-License-Identifier: MPL-2.0
import type { RetainedEngine } from './engine.js';

export async function registerSmlibHooks(engine: RetainedEngine): Promise<void> {
  // Dynamic import keeps the default CLI usable on Node 18.
  const { register } = await import('node:module');
  register(new URL('smlib/node/hooks.mjs', engine.url), {
    data: { smlib: new URL('smlib/', engine.url).href },
  });
}
