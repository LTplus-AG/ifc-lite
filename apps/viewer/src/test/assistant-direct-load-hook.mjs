/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { register, stripTypeScriptTypes } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The isolated child preloads this file before any TS module and uses Node's
// native TypeScript transformer. Node's synchronous module-hook bridge means
// resolve/load must return promptly for abort/deadline/control IPC to run;
// the evaluation barrier below holds the actual import on the main thread.
// A separate hook instance handles source mapping before the IPC gate exists.
if (isMainThread) register(new URL('./assistant-direct-load-hook.mjs?native-ts', import.meta.url).href,
  import.meta.url, { data: { transformOnly: true } });

// Isolated-process #7450 gate: delay genuine client evaluation, never replace
// its functions or responses. IPC controls completion of the actual import.
const isDirect = url => /\/lib\/llm\/stream-direct\.tsx?(?:\?.*)?$/.test(url);
let port;
let transformOnly = false;
const diagnostic = stage => port.postMessage({ kind: 'diagnostic', stage });

export function initialize(data) {
  transformOnly = data.transformOnly === true;
  if (transformOnly) return;
  port = data.port;
  diagnostic('hook:initialize');
  // This port reports diagnostics only; the module receives control on main.
  port.unref();
}

export async function resolve(specifier, context, nextResolve) {
  if (transformOnly) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const requested = new URL(specifier, context.parentURL);
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (!existsSync(fileURLToPath(requested)) && existsSync(fileURLToPath(source))) {
        return nextResolve(source.href, context);
      }
    }
    return nextResolve(specifier, context);
  }
  const observed = /(?:stream-direct|request-service)/.test(specifier);
  if (observed) diagnostic(`hook:resolve:start:${specifier}`);
  const real = await nextResolve(specifier, context);
  if (observed) diagnostic(`hook:resolve:done:${real.url}`);
  return real;
}

export async function load(url, context, nextLoad) {
  if (transformOnly) {
    const loaded = await nextLoad(url, context);
    if (!/\.ts(?:\?.*)?$/.test(url)) return loaded;
    if (loaded.source == null) throw new Error('native TypeScript probe requires genuine module source');
    const source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
    return { ...loaded, format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }) };
  }
  if (/(?:stream-direct|request-service)/.test(url)) diagnostic(`hook:load:${url}`);
  const loaded = await nextLoad(url, context);
  if (!isDirect(url)) return loaded;
  if (loaded.source == null) throw new Error('direct-load gate requires genuine module source');
  // Node24 synchronously proxies resolve AND load. Both hooks must return
  // promptly. A real module's top-level await keeps import completion pending
  // while allowing the caller's actual cancellation/deadline IPC to run.
  const barrier = `await new Promise((resolve, reject) => {
  const receive = command => {
    if (command !== 'release' && command !== 'reject') return;
    process.off('message', receive);
    if (command === 'reject') reject(new Error('controlled direct-client chunk refusal (#7450)'));
    else resolve();
  };
  process.on('message', receive);
  if (process.connected) process.send?.({ kind: 'held' });
  else { process.off('message', receive); reject(new Error('direct-load probe has no IPC receiver')); }
});\n`;
  const source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
  return { ...loaded, source: `${barrier}${source}\nif (process.connected) process.send?.({ kind: 'evaluated' });\n` };
}
