/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BcfApiClient } from '@ifc-lite/bcf-api';
import { parseCapabilities } from '@ifc-lite/extensions';
import type { FetchTransport } from '@ifc-lite/sandbox';
import { createNativeBcfWriteGateway } from './bcf-publication-node.js';
import type { BcfWriteIntent } from './bcf-write-gateway.js';
import { LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN, startLocalBcfServer } from '../../../apps/viewer/src/test/bcf-http-server.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const baseUrl = 'https://bcf.example.test/bcf';
const parsed = parseCapabilities(['network.fetch:bcf.example.test']);
if (!parsed.ok) throw new Error('Invalid controlled host grant');
const networkGrants = parsed.value;

async function fixture(options: Parameters<typeof startLocalBcfServer>[0]) {
  const peer = await startLocalBcfServer(options);
  cleanup.push(peer.close);
  const directory = await mkdtemp(join(tmpdir(), 'bcf-visibility-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const networkTransport: FetchTransport = (url, init) => fetch(new URL(url.pathname + url.search, peer.baseUrl), init);
  const gateway = createNativeBcfWriteGateway({ directory });
  return { peer, directory, gateway, networkTransport };
}

it.each(['createTopic', 'createComment'] as const)(
  'a filtered anonymous200 collection cannot release a real authenticated %s (#7374)', async operation => {
    const { peer, directory, gateway, networkTransport } = await fixture({ anonymousReadVisibility: 'filtered' });
    const client = new BcfApiClient({ baseUrl: peer.baseUrl, getAccessToken: () => LOCAL_BCF_TOKEN });
    const parent = operation === 'createComment'
      ? await client.createTopic(LOCAL_BCF_PROJECT, { title: 'Visibility parent' }) : undefined;
    const intent: BcfWriteIntent = operation === 'createComment'
      ? { nodeType: 'bcf.addComment', operation, baseUrl, version: '2.1', projectId: LOCAL_BCF_PROJECT,
        topicGuid: parent!.guid, payload: { comment: 'Visibility comment' } }
      : { nodeType: 'bcf.createTopic', operation, baseUrl, version: '2.1', projectId: LOCAL_BCF_PROJECT,
        payload: { title: 'Visibility topic' } };
    const send = operation === 'createComment'
      ? () => client.createComment(LOCAL_BCF_PROJECT, parent!.guid, { comment: 'Visibility comment' })
      : () => client.createTopic(LOCAL_BCF_PROJECT, { title: 'Visibility topic' });
    peer.state.loseNextWriteResponse = true;
    await expect(gateway.write(intent, send, [LOCAL_BCF_TOKEN])).rejects.toThrow(/unknown/);
    const effects = operation === 'createComment' ? 2 : 1;
    expect(peer.state.receivedWrites).toBe(effects);
    expect(peer.state.acceptedWrites).toBe(effects);
    const retained = operation === 'createComment'
      ? peer.state.topics.get(parent!.guid)!.comments[0]
      : [...peer.state.topics.values()][0].topic;
    expect(retained.guid).toBeTruthy();
    const fresh = createNativeBcfWriteGateway({ directory });
    const [entry] = await fresh.list();
    const hidden = await fresh.check(entry.id, { networkGrants, networkTransport });
    expect(hidden.check).toMatchObject({ result: 'unavailable', candidates: [] });
    expect(hidden.check?.fullReadAccessConfirmed).toBeUndefined();
    await expect(fresh.confirmAbsent(entry.id)).rejects.toThrow(/absence/);
    await expect(fresh.write(intent, send, [LOCAL_BCF_TOKEN])).rejects.toThrow(/unknown/);
    expect(peer.state.receivedWrites).toBe(effects);
    expect(peer.state.acceptedWrites).toBe(effects);
    // A genuine authorized full read finds the independently retained object;
    // candidates need no absence assertion and remain manual reconciliation choices.
    const visible = await fresh.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants, networkTransport });
    expect(visible.check).toMatchObject({ result: 'ambiguous', candidates: [{ guid: retained.guid }] });
    expect(visible.check?.fullReadAccessConfirmed).toBeUndefined();
    expect(peer.state.receivedWrites).toBe(effects);
  });

it('public complete empty reads require explicit full visibility before deliberate release (#7374)', async () => {
  const { peer, directory, gateway, networkTransport } = await fixture({
    anonymousReadVisibility: 'full', allowAnonymousWrites: true,
  });
  const client = new BcfApiClient({ baseUrl: peer.baseUrl });
  const intent: BcfWriteIntent = { nodeType: 'bcf.createTopic', operation: 'createTopic', baseUrl,
    version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title: 'Public visibility' } };
  const send = () => client.createTopic(LOCAL_BCF_PROJECT, { title: 'Public visibility' });
  peer.state.dropNextWriteBeforeCommit = true;
  await expect(gateway.write(intent, send)).rejects.toThrow(/unknown/);
  expect(peer.state.receivedWriteAttempts).toBe(1);
  expect(peer.state.receivedWrites).toBe(1);
  expect(peer.state.acceptedWrites).toBe(0);
  expect(peer.state.topics.size).toBe(0);
  const fresh = createNativeBcfWriteGateway({ directory });
  const [entry] = await fresh.list();
  expect((await fresh.check(entry.id, { networkGrants, networkTransport })).check?.result).toBe('unavailable');
  await expect(fresh.confirmAbsent(entry.id)).rejects.toThrow(/absence/);
  await expect(fresh.write(intent, send)).rejects.toThrow(/unknown/);
  expect(peer.state.receivedWriteAttempts).toBe(1);
  const checked = await fresh.check(entry.id, { networkGrants, networkTransport, confirmFullReadAccess: true });
  expect(checked.check).toMatchObject({ result: 'absent', candidates: [], fullReadAccessConfirmed: true });
  await createNativeBcfWriteGateway({ directory }).confirmAbsent(entry.id);
  expect(peer.state.receivedWriteAttempts).toBe(1);
  const created = await fresh.write(intent, send);
  expect(peer.state.acceptedWrites).toBe(1);
  expect(peer.state.receivedWrites).toBe(2);
  expect([...peer.state.topics.keys()]).toEqual([created.guid]);
});

it('legacy markerless absence stays readable but cannot authorize release after restart (#7374)', async () => {
  const { peer, directory, gateway, networkTransport } = await fixture({ anonymousReadVisibility: 'full', allowAnonymousWrites: true });
  const client = new BcfApiClient({ baseUrl: peer.baseUrl });
  const intent: BcfWriteIntent = { nodeType: 'bcf.createTopic', operation: 'createTopic', baseUrl,
    version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title: 'Legacy visibility proof' } };
  const send = () => client.createTopic(LOCAL_BCF_PROJECT, { title: 'Legacy visibility proof' });
  peer.state.dropNextWriteBeforeCommit = true;
  await expect(gateway.write(intent, send)).rejects.toThrow(/unknown/);
  expect(peer.state.receivedWriteAttempts).toBe(1);
  expect(peer.state.acceptedWrites).toBe(0);
  const [entry] = await gateway.list();
  await gateway.check(entry.id, { networkGrants, networkTransport, confirmFullReadAccess: true });
  const namespace = (await readdir(directory))[0];
  const digest = entry.id.slice(0, 64);
  const location = join(directory, namespace, 'v2', digest.slice(0, 2), digest);
  // Reconstruct the former immutable wire shape, preserving all actual identity,
  // epoch, timestamp and candidates fields from the real server check.
  const epochs = await readdir(join(location, `${entry.id}.epochs`));
  const epoch = epochs.find(name => /^\d+$/.test(name));
  if (!epoch) throw new Error('Actual persisted check epoch missing');
  const checkedPath = join(location, `${entry.id}.epochs`, epoch, `${entry.id}.checked-1.json`);
  const record: unknown = JSON.parse(await readFile(checkedPath, 'utf8'));
  if (!record || typeof record !== 'object' || !('check' in record) || !record.check || typeof record.check !== 'object') {
    throw new Error('Actual checked proof missing');
  }
  Reflect.deleteProperty(record.check, 'fullReadAccessConfirmed');
  await writeFile(checkedPath, JSON.stringify(record));
  const before = await readFile(checkedPath, 'utf8');
  const restarted = createNativeBcfWriteGateway({ directory });
  expect((await restarted.list())[0].check).toMatchObject({ result: 'absent', candidates: [] });
  await expect(restarted.confirmAbsent(entry.id)).rejects.toThrow(/absence/);
  await expect(restarted.write(intent, send)).rejects.toThrow(/unknown/);
  expect(peer.state.receivedWriteAttempts).toBe(1);
  expect(await readFile(checkedPath, 'utf8')).toBe(before);
  await restarted.check(entry.id, { networkGrants, networkTransport, confirmFullReadAccess: true });
  await restarted.confirmAbsent(entry.id);
  expect(await readFile(checkedPath, 'utf8')).toBe(before);
  expect(peer.state.acceptedWrites).toBe(0);
});

it('a known credential colliding with the new fixed proof value is refused before effect (#7374)', async () => {
  const { peer, directory } = await fixture({ token: 'true' });
  const client = new BcfApiClient({ baseUrl: peer.baseUrl, getAccessToken: () => 'true' });
  const gateway = createNativeBcfWriteGateway({ directory, secrets: ['true'] });
  const intent: BcfWriteIntent = { nodeType: 'bcf.createTopic', operation: 'createTopic', baseUrl,
    version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title: 'Visibility metadata' } };
  await expect(gateway.write(intent, () => client.createTopic(LOCAL_BCF_PROJECT, { title: 'Visibility metadata' })))
    .rejects.toThrow(/credentials must not enter durable state/);
  expect(peer.state.receivedWriteAttempts).toBe(0);
  expect(peer.state.acceptedWrites).toBe(0);
  expect(await readdir(directory)).toEqual([]);
});
