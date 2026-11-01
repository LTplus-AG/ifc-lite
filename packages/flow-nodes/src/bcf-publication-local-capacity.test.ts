/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7374: the local unsettled-send bound, in a file of its own. The bound is process-wide state in
// bcf-publication-node.ts, and this test fills it on purpose. When it ran beside the other
// local-bounds tests, a timeout here (fsync on a loaded disk) left 64 unsettled sends and an
// outcome-EIO spy behind, and the next 19 tests failed with "local unsettled-send limit reached".
// Vitest runs each file in its own worker, so whatever this test leaves dies with it.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BcfApiClient } from '@ifc-lite/bcf-api';
import { parseCapabilities } from '@ifc-lite/extensions';
import { createNativeBcfWriteGateway } from './bcf-publication-node.js';
import { BcfPublicationStore } from './bcf-publication-store.js';
import { LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN, startLocalBcfServer } from '../../../apps/viewer/src/test/bcf-http-server.js';

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposers.splice(0).reverse()) await dispose(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bcf-local-capacity-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const peer = await startLocalBcfServer(); disposers.push(peer.close);
  const transport = (url: URL, init?: RequestInit) => fetch(new URL(url.pathname + url.search, peer.baseUrl), init);
  const client = new BcfApiClient({ baseUrl: 'https://bcf.example.test/bcf', getAccessToken: () => LOCAL_BCF_TOKEN,
    fetchFn: (url, init) => transport(new URL(String(url)), { ...init, redirect: 'manual' }) });
  const gateway = createNativeBcfWriteGateway({ directory, secrets: [LOCAL_BCF_TOKEN] });
  const create = (title: string) => gateway.write({ nodeType: 'bcf.createTopic', operation: 'createTopic',
    baseUrl: 'https://bcf.example.test/bcf', version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title } },
    () => client.createTopic(LOCAL_BCF_PROJECT, { title }));
  return { directory, peer, transport, gateway, create };
}

it('retains only missing-outcome local completions, bounds new effects and frees capacity through genuine checked settlement (#7374)', async () => {
  const { directory, peer, transport, gateway, create } = await fixture();
  // More successful distinct sends than the local bound prove settled receipts do not leak tracking slots.
  for (let index = 0; index < 65; index += 1) await create(`Successful ${index}`);
  expect(peer.state.acceptedWrites).toBe(65);
  const publish = BcfPublicationStore.prototype.publish;
  const fault = vi.spyOn(BcfPublicationStore.prototype, 'publish').mockImplementation(function(this: BcfPublicationStore, ...args: Parameters<BcfPublicationStore['publish']>) {
    const [filename] = args;
    if (filename.endsWith('.outcome.json')) return Promise.reject(Object.assign(new Error('Injected outcome EIO'), { code: 'EIO' }));
    return publish.apply(this, args);
  });
  try {
    for (let index = 0; index < 64; index += 1) await expect(create(`Missing receipt ${index}`)).rejects.toThrow('Injected outcome EIO');
    expect(peer.state.acceptedWrites).toBe(129);
    await expect(create('Capacity refused')).rejects.toThrow('local unsettled-send limit');
    expect(peer.state.receivedWrites).toBe(129);
  } finally { fault.mockRestore(); }
  const uncertain = (await gateway.list()).filter(entry => entry.state === 'uncertain');
  expect(uncertain).toHaveLength(64);
  const capabilities = parseCapabilities(['network.fetch:bcf.example.test']);
  if (!capabilities.ok) throw new Error('Invalid actual server grant');
  // Recovery performs authorized GETs and no create; it also releases locally retained completion identities.
  for (const entry of uncertain) {
    const checked = await gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: capabilities.value, networkTransport: transport });
    expect(checked.check?.candidates).toHaveLength(1);
    await gateway.reconcile(entry.id, checked.check!.candidates[0].guid);
  }
  expect(peer.state.receivedWrites).toBe(129);
  await create('After recovery');
  expect(peer.state.acceptedWrites).toBe(130);
  expect((await createNativeBcfWriteGateway({ directory }).list()).every(entry => entry.state === 'done')).toBe(true);
}, 60000);
