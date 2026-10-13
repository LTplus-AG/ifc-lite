/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7374: real retained effects and malformed filesystem objects, not returned mock DTOs.
import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify, inspect } from 'node:util';
import { mkdtemp, readdir, readFile, writeFile, readlink, open, rm, unlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BcfApiClient, BcfApiError } from '@ifc-lite/bcf-api';
import { parseCapabilities } from '@ifc-lite/extensions';
import { createNativeBcfWriteGateway } from './bcf-publication-node.js';
import { BcfPublicationStore } from './bcf-publication-store.js';
import { record } from './bcf-publication-codec.js';
import { LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN, startLocalBcfServer } from '../../../apps/viewer/src/test/bcf-http-server.js';

const execute = promisify(execFile);
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
async function fixture(options: Parameters<typeof startLocalBcfServer>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bcf-local-bounds-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const peer = await startLocalBcfServer(options); disposers.push(peer.close);
  const transport = (url: URL, init?: RequestInit) => fetch(new URL(url.pathname + url.search, peer.baseUrl), init);
  const client = new BcfApiClient({ baseUrl: 'https://bcf.example.test/bcf', getAccessToken: () => LOCAL_BCF_TOKEN,
    fetchFn: (url, init) => transport(new URL(String(url)), { ...init, redirect: 'manual' }) });
  const gateway = createNativeBcfWriteGateway({ directory, secrets: [LOCAL_BCF_TOKEN] });
  const create = (title: string) => gateway.write({ nodeType: 'bcf.createTopic', operation: 'createTopic',
    baseUrl: 'https://bcf.example.test/bcf', version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title } },
    () => client.createTopic(LOCAL_BCF_PROJECT, { title }));
  return { directory, peer, transport, gateway, create, client };
}

it('invalid URL refusal exposes neither the known credential nor an error cause and sends no POST (#7374)', async () => {
  const { directory, peer } = await fixture();
  const secret = 'invalid"URL\\credential';
  const gateway = createNativeBcfWriteGateway({ directory, secrets: [secret] });
  let failure: unknown;
  try {
    await gateway.write({ nodeType: 'bcf.createTopic', operation: 'createTopic', baseUrl: `invalid ${secret}`,
      version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title: 'Safe title' } }, async () => {
      const response = await fetch(`${peer.baseUrl}/2.1/projects/${LOCAL_BCF_PROJECT}/topics`, {
        method: 'POST', headers: { authorization: `Bearer ${LOCAL_BCF_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Safe title' }) });
      return response.json();
    });
  } catch (error) { failure = error; }
  expect(peer.state.receivedWriteAttempts).toBe(0);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain('invalid server URL');
  expect(inspect(failure, { depth: 10 })).not.toContain('credential');
  expect(inspect(failure, { depth: 10 })).not.toContain(JSON.stringify(secret).slice(1, -1));
  expect(failure instanceof Error && failure.cause).toBeUndefined();
  expect(await gateway.list()).toEqual([]);
});

it.skipIf(process.platform !== 'linux')('a FIFO capacity slot is refused in a bounded fresh process without losing the prior effect (#7374)', async () => {
  const { directory, peer, gateway, create } = await fixture();
  const receipt = await create('Retained before FIFO');
  expect(peer.state.acceptedWrites).toBe(1);
  const [entry] = await gateway.list();
  const namespace = join(directory, (await readdir(directory))[0], 'v2');
  const bucket = join(namespace, entry.id.slice(0, 2));
  const outcome = join(bucket, entry.id.slice(0, 64), `${entry.id}.outcome.json`);
  const bytes = await readFile(outcome);
  const slot = join(bucket, 'slot-0.json');
  const original = await readFile(slot);
  await unlink(slot); await execute('mkfifo', [slot]);
  try {
    const script = `import('@ifc-lite/flow-nodes/bcf-publication-node').then(async m => {
      try { await m.createNativeBcfWriteGateway({directory:process.argv[1]}).listPage(); process.exitCode=2; }
      catch(error) { console.log(JSON.stringify({error:String(error)})); }
    })`;
    const child = await execute(process.execPath, ['--input-type=module', '-e', script, directory], { timeout: 5000 });
    expect(JSON.parse(child.stdout).error).toContain('invalid or oversized stored record');
    expect(await readFile(outcome)).toEqual(bytes);
    expect(peer.state.acceptedWrites).toBe(1);
  } finally {
    await unlink(slot);
    const { writeFile } = await import('node:fs/promises'); await writeFile(slot, original);
  }
  expect((await gateway.list())[0].receipt?.remoteGuid).toBe(receipt.guid);
});

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


it.skipIf(process.platform !== 'linux').each(['outcome', 'settlement'] as const)(
  'a visible %s record whose directory fsync failed cannot authorize another retained effect before durability recovery (#7374)', async kind => {
    const { directory, peer, transport, gateway, create } = await fixture();
    const capabilities = parseCapabilities(['network.fetch:bcf.example.test']);
    if (!capabilities.ok) throw new Error('Invalid actual server grant');
    let target: string;
    if (kind === 'settlement') {
      peer.state.loseNextWriteResponse = true;
      await expect(create('Fsync recovery')).rejects.toThrow('outcome unknown');
      expect(peer.state.acceptedWrites).toBe(1);
      const [entry] = await gateway.list();
      await gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: capabilities.value, networkTransport: transport });
      target = join(directory, (await readdir(directory))[0], 'v2', entry.id.slice(0, 2), entry.id.slice(0, 64),
        `${entry.id}.epochs`, '1', `${entry.id}.check-2.json`);
    } else {
      // Identify the real intent directory during actual effect dispatch, before its outcome is published.
      target = '';
    }
    const probe = await open(directory, 'r');
    const prototype: FileHandle = Object.getPrototypeOf(probe), sync = prototype.sync;
    let failures = 0;
    const fault = vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
      const actual = await readlink(`/proc/self/fd/${this.fd}`);
      if (kind === 'outcome' && /^[a-f0-9]{64}$/.test(actual.split('/').at(-1) ?? '')) {
        const outcome = (await readdir(actual)).find(name => name.endsWith('.outcome.json'));
        if (outcome) target = join(actual, outcome);
      }
      if (target && actual === target.slice(0, target.lastIndexOf('/'))) {
        try { await readFile(target); }
        catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; return sync.call(this); }
        failures += 1;
        throw Object.assign(new Error('Injected visible-record directory EIO'), { code: 'EIO' });
      }
      return sync.call(this);
    });
    let visible: string;
    try {
      if (kind === 'outcome') await expect(create('Fsync recovery')).rejects.toThrow('directory EIO');
      else {
        const [entry] = await gateway.list();
        const guid = [...peer.state.topics.keys()][0];
        await expect(gateway.reconcile(entry.id, guid)).rejects.toThrow('directory EIO');
      }
      expect(peer.state.acceptedWrites).toBe(1);
      visible = await readFile(target, 'utf8');
      const fresh = createNativeBcfWriteGateway({ directory });
      await expect(fresh.list()).rejects.toThrow('directory EIO');
      await expect(create('Fsync recovery')).rejects.toThrow('directory EIO');
      expect(peer.state.receivedWrites).toBe(1);
      expect(failures).toBeGreaterThanOrEqual(3);
      expect(await readFile(target, 'utf8')).toBe(visible);
    } finally { fault.mockRestore(); await probe.close(); }
    const [recovered] = await createNativeBcfWriteGateway({ directory }).list();
    expect(recovered.state).toBe('done');
    expect(recovered.receipt?.remoteGuid).toBe([...peer.state.topics.keys()][0]);
    expect(recovered.receipt?.evidence).toBe(kind === 'outcome' ? 'response' : 'reconciled');
    await create('Fsync recovery');
    expect(peer.state.acceptedWrites).toBe(2);
  });


it.skipIf(process.platform !== 'linux')('a visible intent whose directory fsync failed recovers in the same live process without dispatch (#7374)', async () => {
  const { directory, peer, transport, create } = await fixture();
  const probe = await open(directory, 'r');
  const prototype: FileHandle = Object.getPrototypeOf(probe), sync = prototype.sync;
  let target: string | undefined;
  const fault = vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
    const actual = await readlink(`/proc/self/fd/${this.fd}`);
    if (/^[a-f0-9]{64}$/.test(actual.split('/').at(-1) ?? '')) {
      const name = (await readdir(actual)).find(value => value.endsWith('.intent.json'));
      if (name) {
        target = join(actual, name);
        throw Object.assign(new Error('Injected linked-intent directory EIO'), { code: 'EIO' });
      }
    }
    return sync.call(this);
  });
  let visible: string;
  try {
    await expect(create('Linked intent recovery')).rejects.toThrow('linked-intent directory EIO');
    expect(peer.state.receivedWriteAttempts).toBe(0);
    expect(peer.state.acceptedWrites).toBe(0);
    if (!target) throw new Error('Actual exclusive linked intent missing');
    visible = await readFile(target, 'utf8');
    const fresh = createNativeBcfWriteGateway({ directory });
    await expect(fresh.list()).rejects.toThrow('linked-intent directory EIO');
    expect(await readFile(target, 'utf8')).toBe(visible);
  } finally { fault.mockRestore(); await probe.close(); }
  if (!target) throw new Error('Preserved actual intent path missing');
  const fresh = createNativeBcfWriteGateway({ directory });
  const [entry] = await fresh.list();
  expect(entry.ownerStatus).toBe('alive');
  expect(await readFile(target, 'utf8')).toBe(visible);
  const capabilities = parseCapabilities(['network.fetch:bcf.example.test']);
  if (!capabilities.ok) throw new Error('Invalid actual recovery grant');
  // Our owned publication call ended before HTTP; no owner-stopped override is supplied.
  const checking = fresh.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: capabilities.value, confirmFullReadAccess: true, networkTransport: transport });
  await expect(checking).resolves.toMatchObject({ check: { result: 'absent', candidates: [] } });
  await fresh.confirmAbsent(entry.id);
  expect(peer.state.receivedWriteAttempts).toBe(0);
  await create('Linked intent recovery');
  expect(peer.state.receivedWrites).toBe(1);
  expect(peer.state.acceptedWrites).toBe(1);
  const retained = [...peer.state.topics.values()][0].topic.guid;
  expect((await createNativeBcfWriteGateway({ directory }).list()).find(value => value.state === 'done')?.receipt?.remoteGuid).toBe(retained);
  expect(await readFile(target, 'utf8')).toBe(visible);
});

it('an actual exclusive-link loser cannot clear a concurrently retained live sender (#7374)', async () => {
  const { directory, peer, client, transport, gateway } = await fixture();
  const other = createNativeBcfWriteGateway({ directory });
  const intent = { nodeType: 'bcf.createTopic', operation: 'createTopic' as const, baseUrl: 'https://bcf.example.test/bcf',
    version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title: 'Owned concurrent link' } };
  let firstReady!: () => void, secondReady!: () => void, committed!: () => void;
  let releaseFirst!: () => void, releaseSecond!: () => void, releaseSender!: () => void;
  const enteredFirst = new Promise<void>(resolve => { firstReady = resolve; });
  const enteredSecond = new Promise<void>(resolve => { secondReady = resolve; });
  const retained = new Promise<void>(resolve => { committed = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const senderGate = new Promise<void>(resolve => { releaseSender = resolve; });
  const publish = BcfPublicationStore.prototype.publish;
  let entered = 0;
  const gate = vi.spyOn(BcfPublicationStore.prototype, 'publish').mockImplementation(async function(this: BcfPublicationStore,
    ...args: Parameters<BcfPublicationStore['publish']>) {
    if (args[0].endsWith('.intent.json')) {
      entered += 1;
      if (entered === 1) { firstReady(); await firstGate; }
      else if (entered === 2) { secondReady(); await secondGate; }
    }
    return publish.apply(this, args);
  });
  let first: ReturnType<typeof client.createTopic> | undefined;
  let second: ReturnType<typeof client.createTopic> | undefined;
  let guid: string | undefined;
  try {
    first = gateway.write(intent, async () => {
      const dto = await client.createTopic(LOCAL_BCF_PROJECT, intent.payload);
      guid = dto.guid; committed(); await senderGate; return dto;
    });
    await enteredFirst;
    second = other.write(intent, () => client.createTopic(LOCAL_BCF_PROJECT, intent.payload));
    const lost = second.then(() => undefined, error => error as unknown);
    await enteredSecond;
    releaseFirst(); await retained;
    expect(peer.state.receivedWrites).toBe(1);
    expect(peer.state.acceptedWrites).toBe(1);
    expect([...peer.state.topics.values()][0].topic.guid).toBe(guid);
    releaseSecond();
    const failure: unknown = await lost;
    expect(failure).toMatchObject({ code: 'EEXIST' });
    const fresh = createNativeBcfWriteGateway({ directory });
    const [entry] = await fresh.list();
    const capabilities = parseCapabilities(['network.fetch:bcf.example.test']);
    if (!capabilities.ok) throw new Error('Invalid actual peer grant');
    await expect(fresh.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: capabilities.value, networkTransport: transport }))
      .rejects.toThrow(/active/);
    expect(peer.state.receivedWrites).toBe(1);
  } finally {
    releaseFirst(); releaseSecond(); releaseSender();
    await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
    gate.mockRestore();
  }
  expect((await createNativeBcfWriteGateway({ directory }).list())[0].receipt?.remoteGuid).toBe(guid);
  expect(peer.state.acceptedWrites).toBe(1);
});

it('a real manual303 API answer after retained POST survives restart as uncertain until checked manual reconciliation (#7374)', async () => {
  const { directory, peer, transport, gateway, client } = await fixture({ afterWriteStatus: 303 });
  const payload = { title: 'Manual redirect native effect' };
  const writeIntent = { nodeType: 'bcf.createTopic', operation: 'createTopic' as const,
    baseUrl: 'https://bcf.example.test/bcf', version: '2.1', projectId: LOCAL_BCF_PROJECT, payload };
  let apiFailure: unknown, failure: unknown;
  const send = async () => {
    try { return await client.createTopic(LOCAL_BCF_PROJECT, payload); }
    catch (error) { apiFailure = error; throw error; }
  };
  try { await gateway.write(writeIntent, send); } catch (error) { failure = error; }
  expect(peer.state.acceptedWrites).toBe(1);
  expect(peer.state.topics.size).toBe(1);
  expect(apiFailure instanceof BcfApiError && apiFailure.status).toBe(303);
  expect(String(failure)).toContain('outcome unknown');
  const fresh = createNativeBcfWriteGateway({ directory });
  const [entry] = await fresh.list();
  expect(entry).toMatchObject({ state: 'uncertain', failure: { code: 'no-response' } });
  await expect(fresh.write(writeIntent, send)).rejects.toThrow('unknown outcome');
  expect(peer.state.receivedWrites).toBe(1);
  const capabilities = parseCapabilities(['network.fetch:bcf.example.test']);
  if (!capabilities.ok) throw new Error('Invalid actual server grant');
  const guid = [...peer.state.topics.keys()][0];
  const checked = await fresh.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: capabilities.value, networkTransport: transport });
  expect(checked.check?.candidates).toEqual([{ guid }]);
  await fresh.reconcile(entry.id, guid);
  expect((await createNativeBcfWriteGateway({ directory }).list())[0].receipt?.remoteGuid).toBe(guid);
  expect(peer.state.receivedWrites).toBe(1);
});

it('a stored false definite303 rejection cannot release an actual retained redirect effect (#7374)', async () => {
  const { directory, peer, gateway, create } = await fixture({ afterWriteStatus: 303 });
  await expect(create('Retained redirect')).rejects.toThrow(/outcome unknown/);
  expect(peer.state.acceptedWrites).toBe(1);
  const [entry] = await gateway.list();
  expect(entry.state).toBe('uncertain');
  const path = join(directory, (await readdir(directory))[0], 'v2', entry.id.slice(0, 2), entry.id.slice(0, 64), `${entry.id}.outcome.json`);
  const original = await readFile(path, 'utf8');
  const changed: unknown = JSON.parse(original);
  if (!record(changed) || !record(changed.failure)) throw new Error('Expected actual persisted uncertain outcome');
  changed.state = 'failed'; changed.failure.code = 'rejected'; changed.failure.status = 303;
  await writeFile(path, JSON.stringify(changed));
  await expect(createNativeBcfWriteGateway({ directory }).list()).rejects.toThrow(/classification/);
  await expect(create('Retained redirect')).rejects.toThrow(/classification/);
  expect(peer.state.receivedWriteAttempts).toBe(1);
  await writeFile(path, original);
  expect((await createNativeBcfWriteGateway({ directory }).list())[0].state).toBe('uncertain');
  expect(peer.state.topics.size).toBe(1);
});


it.each(['configured', 'ephemeral'] as const)(
  'fixed intent keys preserve %s bearer intent across actual distinct effects and fresh receipt reads (#7374)', async source => {
    const token = 'intent';
    const { directory, peer } = await fixture({ token, guidPrefix: 'cafe' });
    const gateway = createNativeBcfWriteGateway({ directory, ...(source === 'configured' ? { secrets: [token] } : {}) });
    const client = new BcfApiClient({ baseUrl: peer.baseUrl, getAccessToken: () => token });
    const payload = { title: 'Clean topic' };
    const input = { nodeType: 'bcf.createTopic', operation: 'createTopic' as const,
      baseUrl: 'https://bcf.example.test/bcf', version: '2.1', projectId: LOCAL_BCF_PROJECT, payload };
    const create = () => gateway.write(input, () => client.createTopic(LOCAL_BCF_PROJECT, payload),
      source === 'ephemeral' ? [token] : []);
    const first = await create(), second = await create();
    expect(peer.state.acceptedWrites).toBe(2);
    expect(peer.state.receivedWriteAttempts).toBe(2);
    expect(first.guid).not.toBe(second.guid);
    expect([...peer.state.topics.keys()]).toEqual([first.guid, second.guid]);
    const fresh = createNativeBcfWriteGateway({ directory, secrets: [token] });
    const entries = await fresh.list();
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.receipt?.remoteGuid)).toEqual([first.guid, second.guid]);
    expect(entries.every(entry => entry.state === 'done' && Reflect.get(entry.intent.payload, 'title') === payload.title)).toBe(true);
    // The public fixed intent key is protocol; exact bearer values never enter the saved effect/receipt.
    expect(entries.every(entry => entry.receipt?.remoteGuid.includes(token) === false)).toBe(true);
    expect([...peer.state.topics.values()].every(entry => entry.topic.title === payload.title)).toBe(true);
  });

it.each(['configured', 'ephemeral'] as const)(
  'an unrepresentable %s done bearer is refused before the real authenticated POST (#7374)', async source => {
    const token = 'done';
    const { directory, peer } = await fixture({ token, guidPrefix: 'cafe' });
    const gateway = createNativeBcfWriteGateway({ directory, ...(source === 'configured' ? { secrets: [token] } : {}) });
    const client = new BcfApiClient({ baseUrl: peer.baseUrl, getAccessToken: () => token });
    const payload = { title: 'Clean topic' };
    const input = { nodeType: 'bcf.createTopic', operation: 'createTopic' as const,
      baseUrl: 'https://bcf.example.test/bcf', version: '2.1', projectId: LOCAL_BCF_PROJECT, payload };
    await expect(gateway.write(input, () => client.createTopic(LOCAL_BCF_PROJECT, payload),
      source === 'ephemeral' ? [token] : [])).rejects.toThrow('credentials must not enter durable state');
    expect(peer.state.receivedWriteAttempts).toBe(0);
    expect(peer.state.acceptedWrites).toBe(0);
    expect(await createNativeBcfWriteGateway({ directory, secrets: [token] }).list()).toEqual([]);
  });

it('a known bearer collision with an actual generated receipt timestamp refuses success while retaining the recoverable effect (#7374)', async () => {
  const token = '2041-12-13T14:15:16.000Z';
  const { directory, peer, transport } = await fixture({ token, guidPrefix: 'cafe' });
  const gateway = createNativeBcfWriteGateway({ directory, secrets: [token] });
  const client = new BcfApiClient({ baseUrl: peer.baseUrl, getAccessToken: () => token });
  const payload = { title: 'Clean topic' };
  const input = { nodeType: 'bcf.createTopic', operation: 'createTopic' as const,
    baseUrl: 'https://bcf.example.test/bcf', version: '2.1', projectId: LOCAL_BCF_PROJECT, payload };
  const clock = vi.spyOn(Date.prototype, 'toISOString');
  try {
    await expect(gateway.write(input, async () => {
      const result = await client.createTopic(LOCAL_BCF_PROJECT, payload);
      // Only after the independent real HTTP peer accepted the effect do we fault the actual generated timestamp.
      clock.mockReturnValue(token);
      return result;
    })).rejects.toThrow('credentials must not enter durable state');
  } finally { clock.mockRestore(); }
  expect(peer.state.acceptedWrites).toBe(1);
  expect(peer.state.receivedWriteAttempts).toBe(1);
  const guid = [...peer.state.topics.keys()][0];
  expect(peer.state.topics.get(guid)?.topic.title).toBe(payload.title);
  const fresh = createNativeBcfWriteGateway({ directory, secrets: [token] });
  const [entry] = await fresh.list();
  expect(entry.state).toBe('uncertain');
  expect(entry.receipt).toBeUndefined();
  expect(Reflect.get(entry.intent.payload, 'title')).toBe(payload.title);
  await expect(fresh.write(input, () => client.createTopic(LOCAL_BCF_PROJECT, payload))).rejects.toThrow('unknown outcome');
  expect(peer.state.receivedWriteAttempts).toBe(1);
  const capabilities = parseCapabilities(['network.fetch:bcf.example.test']);
  if (!capabilities.ok) throw new Error('Invalid actual server grant');
  const checked = await fresh.check(entry.id, { token, networkGrants: capabilities.value, networkTransport: transport });
  expect(checked.check?.candidates).toEqual([{ guid }]);
  await fresh.reconcile(entry.id, guid);
  expect((await createNativeBcfWriteGateway({ directory, secrets: [token] }).list())[0].receipt?.remoteGuid).toBe(guid);
  expect(peer.state.receivedWriteAttempts).toBe(1);
});

// #7374: direct public callbacks must have the same identifier safety as real Flow checkedSend.
for (const field of ['guid', 'topic_guid', 'viewpoint_guid', 'reply_to_comment_guid'] as const) {
  it.each(['configured', 'ephemeral'] as const)(`raw native %s callback refuses credential-bearing ${field} without settling or replaying the real effect (#7374)`, async enrollment => {
    const token = 'beef';
    const unsafe = 'beef0000-0000-4000-8000-000000000999';
    const { directory, peer, transport } = await fixture({ token, guidPrefix: field === 'guid' ? 'beef' : 'cafe',
      ...(field === 'topic_guid' ? { commentResponseTopicGuid: unsafe } : {}),
      ...(field === 'viewpoint_guid' ? { commentResponseViewpointGuid: unsafe } : {}),
      ...(field === 'reply_to_comment_guid' ? { commentResponseReplyToCommentGuid: unsafe } : {}) });
    const client = new BcfApiClient({ baseUrl: 'https://bcf.example.test/bcf', getAccessToken: () => token,
      fetchFn: (url, init) => transport(new URL(String(url)), init) });
    const parent = field === 'guid' ? undefined : await client.createTopic(LOCAL_BCF_PROJECT, { title: 'Parent topic' });
    const writeIntent = parent ? { nodeType: 'bcf.addComment', operation: 'createComment' as const,
      baseUrl: 'https://bcf.example.test/bcf', version: '2.1', projectId: LOCAL_BCF_PROJECT,
      topicGuid: parent.guid, payload: { comment: 'Safe comment' } }
      : { nodeType: 'bcf.createTopic', operation: 'createTopic' as const, baseUrl: 'https://bcf.example.test/bcf',
        version: '2.1', projectId: LOCAL_BCF_PROJECT, payload: { title: 'Safe topic' } };
    const send = () => parent ? client.createComment(LOCAL_BCF_PROJECT, parent.guid, { comment: 'Safe comment' })
      : client.createTopic(LOCAL_BCF_PROJECT, { title: 'Safe topic' });
    const options = { directory, ...(enrollment === 'configured' ? { secrets: [token] } : {}) };
    const ephemeral = enrollment === 'ephemeral' ? [token] : [];
    let failure: unknown, returned: unknown;
    try { returned = await createNativeBcfWriteGateway(options).write(writeIntent, send, ephemeral); }
    catch (error) { failure = error; }
    const count = parent ? 2 : 1;
    expect(peer.state.receivedWrites).toBe(count);
    expect(peer.state.acceptedWrites).toBe(count);
    const retained = [...peer.state.topics.values()][0];
    expect(retained).toBeDefined();
    if (parent) {
      expect(retained.comments).toHaveLength(1);
      expect(retained.comments[0].topic_guid).toBe(parent.guid);
      expect(retained.comments[0].comment).toBe('Safe comment');
    } else expect(retained.topic.title).toBe('Safe topic');
    expect(String(failure)).toContain('outcome unknown');
    expect(returned).toBeUndefined();
    const fresh = createNativeBcfWriteGateway(options);
    const [entry] = await fresh.list();
    expect(entry.state).toBe('uncertain');
    expect(entry.receipt).toBeUndefined();
    expect(inspect(entry, { depth: null })).not.toContain(token);
    await expect(fresh.write(writeIntent, send, ephemeral)).rejects.toThrow('unknown outcome');
    expect(peer.state.receivedWrites).toBe(count);
  });
}

it('raw native receipt preserves clean primary and nullable optional relationship identifiers (#7374)', async () => {
  const token = 'beef';
  const { directory, peer, transport } = await fixture({ token, guidPrefix: 'cafe', commentResponseViewpointGuid: null, commentResponseReplyToCommentGuid: null });
  const client = new BcfApiClient({ baseUrl: 'https://bcf.example.test/bcf', getAccessToken: () => token,
    fetchFn: (url, init) => transport(new URL(String(url)), init) });
  const parent = await client.createTopic(LOCAL_BCF_PROJECT, { title: 'Parent topic' });
  const result = await createNativeBcfWriteGateway({ directory, secrets: [token] }).write({
    nodeType: 'bcf.addComment', operation: 'createComment', baseUrl: 'https://bcf.example.test/bcf',
    version: '2.1', projectId: LOCAL_BCF_PROJECT, topicGuid: parent.guid, payload: { comment: 'Safe comment' } },
    () => client.createComment(LOCAL_BCF_PROJECT, parent.guid, { comment: 'Safe comment' }));
  expect(peer.state.acceptedWrites).toBe(2);
  const retained = peer.state.topics.get(parent.guid)?.comments[0];
  expect(retained).toBeDefined();
  expect(result.guid).toBe(retained?.guid);
  expect(result.topic_guid).toBe(parent.guid);
  expect(result.viewpoint_guid).toBeNull();
  expect(result.reply_to_comment_guid).toBeNull();
  const [entry] = await createNativeBcfWriteGateway({ directory, secrets: [token] }).list();
  expect(entry.state).toBe('done');
  expect(entry.receipt?.remoteGuid).toBe(retained?.guid);
});
