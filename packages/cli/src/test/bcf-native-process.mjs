/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7374: actual CLI Flow host in a fresh process, with a controlled HTTP peer. */
import { readFile } from 'node:fs/promises';
import { parseCapabilities } from '@ifc-lite/extensions';
import { BcfApiClient } from '@ifc-lite/bcf-api';
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
const session = createCliFlowSession({ store, backend, bim: createBimContext({ backend }) }, grants.value, undefined,
  { directory: config.directory, namespace: config.namespace });
const host = { ...session.host, networkTransport: (url, init) => {
  if (url.origin !== 'https://bcf.example.test') throw new Error('Unexpected controlled network target');
  return fetch(config.baseUrl + url.pathname.replace(/^\/bcf/, '') + url.search, init);
} };
if (config.mode === 'trimmed') {
  // Standard nodes already trim input. The public native gateway also accepts
  // untrimmed text from custom native hosts: exercise that real consumer path.
  const comment = config.operation === 'comment';
  const client = new BcfApiClient({ baseUrl: 'https://bcf.example.test/bcf', getAccessToken: () => config.token,
    fetchFn: (url, init) => host.networkTransport(new URL(url), init) });
  const payload = comment ? { comment: config.title } : { title: config.title, topic_status: 'Open' };
  const intent = { nodeType: comment ? 'bcf.addComment' : 'bcf.createTopic', operation: comment ? 'createComment' : 'createTopic',
    baseUrl: 'https://bcf.example.test/bcf', version: '2.1', projectId: config.projectId,
    ...(comment ? { topicGuid: config.topicGuid } : {}), payload };
  try {
    await host.bcfWrites.write(intent, () => comment ? client.createComment(config.projectId, config.topicGuid, payload)
      : client.createTopic(config.projectId, payload));
    console.log(JSON.stringify({ ok: true }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error) }));
  }
} else {
const result = await runFlow({ flowVersion: 1, id: 'native-kill', name: 'native-kill', capabilities: ['network.fetch:bcf.example.test'],
  inputs: config.player ? [{ nodeId: 'write', param: 'token', label: 'BCF token', kind: 'scalar' }] : [], outputs: [], edges: [], nodes: [{ id: 'write', type: config.operation === 'comment' ? 'bcf.addComment' : 'bcf.createTopic', params: { baseUrl: 'https://bcf.example.test/bcf',
    projectId: config.projectId, token: config.player ? 'unused-default' : config.token, ...(config.operation === 'comment' ?
      { topicGuid: config.topicGuid, comment: config.title } : { title: config.title ?? 'Duct hits beam', status: 'Open' }) } }] },
  { host, registry: createStandardRegistry(), features: headlessFeatures(), ...(config.player ? { inputs: { 'write.token': config.token } } : {}) });
console.log(JSON.stringify({ ok: result.ok, errors: result.reports.map(report => report.error).filter(Boolean) }));
}
