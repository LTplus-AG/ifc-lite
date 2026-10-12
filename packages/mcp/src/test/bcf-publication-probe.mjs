/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7374: a fresh native process using existing host/tool entry points. */
import { loadIfcModel } from '../loader.ts';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.ts';
import { fullScope } from '../auth/scope.ts';
import { buildDefaultToolRegistry } from '../tools/index.ts';

const config = JSON.parse(process.argv[2]);
const realFetch = globalThis.fetch;
// Keep the production HTTPS/exact-host gate; forward only this controlled
// target to the independently retained loopback peer. All effects are real HTTP.
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://bcf-peer.test') throw new Error('Unexpected test network target');
  if (config.disconnectBeforeWrite && init?.method === 'POST') throw new Error('Controlled connection loss before peer received write');
  const response = await realFetch(config.baseUrl + url.pathname.replace(/^\/bcf/, '') + url.search, init);
  if (config.holdAfterWrite && init?.method === 'POST') await new Promise(() => {});
  return response;
};
const registry = new InMemoryModelRegistry();
registry.add(await loadIfcModel(config.model, { modelId: 'sample' }));
const scope = { ...fullScope(), ...(config.principal ? { user: config.principal } : {}) };
const context = { registry, scope, progress: NOOP_PROGRESS, log: SILENT_LOGGER,
  signal: new AbortController().signal, config: DEFAULT_CONFIG,
  ...(config.principal ? { session: { id: crypto.randomUUID(), principal: config.principal } }
    : config.remoteUnidentified ? { session: { id: crypto.randomUUID() } } : {}) };
const tools = buildDefaultToolRegistry();
const tool = tools.get(config.tool ?? 'run_flow');
if (!tool) throw new Error('Expected recovery tool to be registered');
try {
  const result = await tool.handler(config.input, context);
  console.log(JSON.stringify({ result }));
} catch (error) {
  console.log(JSON.stringify({ error: { message: error.message, code: error.code } }));
} finally {
  for (const model of registry.list()) registry.remove(model.id);
}
