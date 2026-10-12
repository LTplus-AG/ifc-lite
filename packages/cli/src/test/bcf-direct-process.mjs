/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7374: actual CLI Flow host in a fresh process, with a controlled HTTP peer. */
import { readFile } from 'node:fs/promises';
import { parseCapabilities } from '@ifc-lite/extensions';
import { runFlow } from '@ifc-lite/flow';
import { createBimContext } from '@ifc-lite/sdk';
import { createStandardRegistry, headlessFeatures } from '@ifc-lite/flow-nodes';
import { createCliFlowSession } from '../commands/flow-host.ts';
import { parseIfcBytes } from '../loader.ts';
import { HeadlessBackend } from '../headless-backend.ts';

const config = JSON.parse(process.argv[2]);
const store = await parseIfcBytes(await readFile(config.model), 'hello-wall.ifc');
const backend = new HeadlessBackend(store, 'hello-wall.ifc');
const grants = parseCapabilities(['network.fetch:bcf.example.test']);
if (!grants.ok) throw new Error('Invalid controlled test grant');
const session = createCliFlowSession({ store, backend, bim: createBimContext({ backend }) }, grants.value);
const host = { ...session.host, networkTransport: (url, init) => {
  if (url.origin !== 'https://bcf.example.test') throw new Error('Unexpected controlled network target');
  return fetch(config.baseUrl + url.pathname.replace(/^\/bcf/, '') + url.search, init);
} };
if (config.gateway) {
  // Actual custom host service delegates to the real BCF client, not an injected error/DTO.
  host.bcfWrites = { write: async (_intent, send) => send() };
} else delete host.bcfWrites;
const result = await runFlow({ flowVersion: 1, id: 'native-kill', name: 'native-kill', capabilities: ['network.fetch:bcf.example.test'],
  inputs: config.player ? [{ nodeId: 'write', param: 'token', label: 'BCF token', kind: 'scalar' }] : [], outputs: [{ nodeId: 'write', port: config.operation === 'comment' ? 'created' : 'topics', label: 'Published' }], edges: [], nodes: [{ id: 'write', type: config.operation === 'comment' ? 'bcf.addComment' : 'bcf.createTopic', params: { baseUrl: 'https://bcf.example.test/bcf',
    projectId: config.projectId, token: config.player ? 'unused-default' : config.token, ...(config.operation === 'comment' ?
      { topicGuid: config.topicGuid, comment: config.title } : { title: config.title ?? 'Duct hits beam', status: 'Open' }) } }] },
  { host, registry: createStandardRegistry(), features: headlessFeatures(), ...(config.player ? { inputs: { 'write.token': config.token } } : {}) });
console.log(JSON.stringify({ ok: result.ok, errors: result.reports.map(report => report.error).filter(Boolean), outputs: Object.fromEntries([...result.outputs].map(([id, ports]) => [id, Object.fromEntries(ports)])) }));
