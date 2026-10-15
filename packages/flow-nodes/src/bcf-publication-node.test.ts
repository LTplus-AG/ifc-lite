/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7374: real retained HTTP effects, exclusive ownership and fail-closed disk recovery.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BcfPublicationStore } from './bcf-publication-store.js';
import { intentDigest } from './bcf-publication-codec.js';
import { createServer } from 'node:http';
import { mkdtemp, open, readdir, readFile, readlink, rm, writeFile, mkdir, symlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BcfApiClient, BcfApiError } from '@ifc-lite/bcf-api';
import { parseCapabilities } from '@ifc-lite/extensions';
import { runFlow, type FlowDocument } from '@ifc-lite/flow';
import type { FetchTransport } from '@ifc-lite/sandbox';
import { createNativeBcfWriteGateway } from './bcf-publication-node.js';
import type { BcfWriteIntent } from './bcf-write-gateway.js';
import { createFakeBim } from './__tests__/fake-backend.js';
import { createStandardRegistry, headlessFeatures, type FlowHost } from './index.js';
import { LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN, startLocalBcfServer } from '../../../apps/viewer/src/test/bcf-http-server.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bcf-native-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const baseUrl = 'https://bcf.example.test/bcf';
const intent: BcfWriteIntent = { nodeType: 'bcf.createTopic', operation: 'createTopic', baseUrl, version: '2.1',
  projectId: LOCAL_BCF_PROJECT, payload: { title: 'Duct hits beam', topic_status: 'Open' } };
const grantResult = parseCapabilities(['network.fetch:bcf.example.test']);
if (!grantResult.ok) throw new Error('test grant invalid');
const grants = grantResult.value;
async function fixture() {
  const peer = await startLocalBcfServer();
  cleanup.push(peer.close);
  const dir = await directory();
  const transport: FetchTransport = (url, init) => fetch(new URL(url.pathname + url.search, peer.baseUrl), init);
  const gateway = createNativeBcfWriteGateway({ directory: dir, secrets: [LOCAL_BCF_TOKEN] });
  return { peer, dir, transport, gateway };
}
function run(gateway: FlowHost['bcfWrites'], transport: FetchTransport, title = 'Duct hits beam', allowed = grants) {
  const doc: FlowDocument = { flowVersion: 1, id: 'native', name: 'native', capabilities: ['network.fetch:bcf.example.test'],
    inputs: [], outputs: [], edges: [], nodes: [{ id: 'write', type: 'bcf.createTopic',
      params: { baseUrl, projectId: LOCAL_BCF_PROJECT, token: LOCAL_BCF_TOKEN, title, status: 'Open' } }] };
  return runFlow(doc, { host: { bim: createFakeBim().bim, networkGrants: allowed, networkTransport: transport, bcfWrites: gateway },
    registry: createStandardRegistry(), features: headlessFeatures() });
}
async function namespaceDir(dir: string) { return join(dir, (await readdir(dir))[0], 'v2'); }
async function entryDir(dir: string, id: string) { return join(await namespaceDir(dir), id.slice(0, 2), id.slice(0, 64)); }
async function disk(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    parts.push(item.isDirectory() ? await disk(path) : await readFile(path, 'utf8'));
  }
  return parts.join('\n');
}

describe('native durable BCF publication (#7374)', () => {
  it.each(['sparse labels', 'nonenumerable title', 'inherited title', 'throwing serialization'] as const)(
    'JSON snapshot refuses %s before persisting or calling the real HTTP client (#7374)', async mode => {
      const { peer, dir, gateway } = await fixture();
      const client = new BcfApiClient({ baseUrl: peer.baseUrl, getAccessToken: () => LOCAL_BCF_TOKEN });
      const payload = { title: 'JSON schema refusal', labels: mode === 'sparse labels' ? Array<string>(1) : [] };
      if (mode === 'nonenumerable title') Object.defineProperty(payload, 'title', { enumerable: false });
      if (mode === 'inherited title') {
        Reflect.deleteProperty(payload, 'title');
        Object.setPrototypeOf(payload, { title: 'JSON schema refusal' });
      }
      if (mode === 'throwing serialization') Object.defineProperty(payload, 'toJSON', {
        value: () => { throw new Error(`Serialization contains ${LOCAL_BCF_TOKEN}`); },
      });
      let failure: unknown;
      try { await gateway.write({ ...intent, payload }, () => client.createTopic(LOCAL_BCF_PROJECT, payload)); }
      catch (error) { failure = error; }
      // The independently active API peer observes every attempted write, including its400 refusals.
      expect(peer.state.receivedWriteAttempts).toBe(0);
      expect(peer.state.acceptedWrites).toBe(0);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(LOCAL_BCF_TOKEN);
      expect(failure instanceof Error ? failure.cause : undefined).toBeUndefined();
      expect(String(failure)).toMatch(/invalid labels|invalid write payload/);
      if (mode === 'throwing serialization') {
        // A later raw scan must not replace inspection of the exact saved snapshot.
        const changing = { title: 'Changing serialization' };
        let calls = 0;
        Object.defineProperty(changing, 'toJSON', { value: () => ({
          title: ++calls === 1 ? `Contains ${LOCAL_BCF_TOKEN}` : 'Changing serialization',
        }) });
        let snapshotFailure: unknown;
        try { await gateway.write({ ...intent, payload: changing }, () => client.createTopic(LOCAL_BCF_PROJECT, changing)); }
        catch (error) { snapshotFailure = error; }
        expect(peer.state.receivedWriteAttempts).toBe(0);
        expect(peer.state.acceptedWrites).toBe(0);
        expect(String(snapshotFailure)).toContain('credentials must not enter durable state');
        // Removing the normalized-snapshot guard reaches real store preparation
        // before its final publish defense rejects the credential-bearing snapshot.
        expect(await readdir(dir)).toEqual([]);
      }
      expect(await createNativeBcfWriteGateway({ directory: dir }).list()).toEqual([]);
    });

  it('own undefined optional intent fields preserve real receipts and lost-response recovery across fresh factories (#7374)', async () => {
    const { peer, dir, transport, gateway } = await fixture();
    const client = new BcfApiClient({ baseUrl: peer.baseUrl, getAccessToken: () => LOCAL_BCF_TOKEN });
    const first = { ...intent, topicGuid: undefined,
      payload: { title: 'Undefined optional receipt', description: undefined } } satisfies BcfWriteIntent;
    const result = await gateway.write(first, () => client.createTopic(LOCAL_BCF_PROJECT, first.payload));
    expect(peer.state.receivedWrites).toBe(1);
    expect(peer.state.acceptedWrites).toBe(1);
    expect([...peer.state.topics.values()][0].topic.guid).toBe(result.guid);
    const fresh = createNativeBcfWriteGateway({ directory: dir, secrets: [LOCAL_BCF_TOKEN] });
    const saved = await fresh.list();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ state: 'done', receipt: { remoteGuid: result.guid } });
    expect(peer.state.receivedWrites).toBe(1);

    peer.state.loseNextWriteResponse = true;
    const lost = { ...intent, topicGuid: undefined,
      payload: { title: 'Undefined optional lost response', description: undefined } } satisfies BcfWriteIntent;
    await expect(fresh.write(lost, () => client.createTopic(LOCAL_BCF_PROJECT, lost.payload))).rejects.toThrow(/outcome unknown/);
    expect(peer.state.receivedWrites).toBe(2);
    expect(peer.state.acceptedWrites).toBe(2);
    const restart = createNativeBcfWriteGateway({ directory: dir, secrets: [LOCAL_BCF_TOKEN] });
    const entry = (await restart.list()).find(value => Reflect.get(value.intent.payload, 'title') === 'Undefined optional lost response');
    expect(entry).toMatchObject({ state: 'uncertain' });
    if (!entry) throw new Error('Actual lost-response intent missing');
    await expect(restart.write(lost, () => client.createTopic(LOCAL_BCF_PROJECT, lost.payload))).rejects.toThrow(/unknown outcome/);
    const original = [...peer.state.topics.values()].find(value => value.topic.title === 'Undefined optional lost response')?.topic.guid;
    if (!original) throw new Error('Independently retained lost-response effect missing');
    const checked = await restart.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants, networkTransport: transport });
    expect(checked.check?.candidates).toEqual([{ guid: original }]);
    await restart.reconcile(entry.id, original);
    expect((await createNativeBcfWriteGateway({ directory: dir }).list()).find(value => value.id === entry.id))
      .toMatchObject({ state: 'done', receipt: { remoteGuid: original } });
    expect(peer.state.receivedWrites).toBe(2);
    expect(peer.state.acceptedWrites).toBe(2);
  });

  it('schema-key exemptions never admit credential values, URLs or unknown intent/payload fields (#7374)', async () => {
    const peer = await startLocalBcfServer({ token: 'id', guidPrefix: 'cafe' });
    cleanup.push(peer.close);
    const dir = await directory();
    const gateway = createNativeBcfWriteGateway({ directory: dir, secrets: ['id'] });
    const client = new BcfApiClient({ baseUrl: peer.baseUrl, getAccessToken: () => 'id' });
    const clean = { ...intent, payload: { title: 'Clean topic' } };
    for (const bad of [
      { ...clean, payload: { title: 'Contains id credential' } },
      { ...clean, baseUrl: `${baseUrl}/id` },
      { ...clean, id: 'unknown intent field' },
      { ...clean, payload: { title: 'Clean topic', id: 'unknown payload field' } },
      { ...clean, payload: { title: 'Clean topic', 'dynamic-id-key': 'safe' } },
      { ...clean, payload: { title: 'Clean topic', token: 'safe' } },
    ]) {
      await expect(gateway.write(bad, () => client.createTopic(LOCAL_BCF_PROJECT, clean.payload))).rejects.toThrow(/credentials|unknown|payload/);
      expect(peer.state.receivedWriteAttempts).toBe(0);
    }
    expect(await gateway.list()).toEqual([]);
    const created = await gateway.write(clean, () => client.createTopic(LOCAL_BCF_PROJECT, clean.payload));
    expect(peer.state.acceptedWrites).toBe(1);
    expect(created.guid.startsWith('cafe')).toBe(true);
    expect((await createNativeBcfWriteGateway({ directory: dir, secrets: ['id'] }).list())[0].receipt?.remoteGuid).toBe(created.guid);
  });

  it('rejects known secrets requiring JSON escapes before any effect or durable intent', async () => {
    const dir = await directory();
    let effects = 0;
    for (const secret of ['opaque"credential', 'opaque\\credential', 'opaque\ncredential']) {
      const gateway = createNativeBcfWriteGateway({ directory: dir, secrets: [secret] });
      await expect(gateway.write({ ...intent, payload: { title: `Issue ${secret}` } }, async () => {
        effects += 1; return { guid: 'unexpected-effect' };
      })).rejects.toThrow(/credentials/);
      expect(await gateway.list()).toEqual([]);
      expect(await disk(dir)).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
    expect(effects).toBe(0);
  });

  it('enumerates a real server-capped 100-row page before finding the 101st committed effect', async () => {
    const { peer, transport, gateway } = await fixture();
    for (let index = 0; index < 100; index += 1) {
      const response = await fetch(`${peer.baseUrl}/2.1/projects/${LOCAL_BCF_PROJECT}/topics`, {
        method: 'POST', headers: { authorization: `Bearer ${LOCAL_BCF_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: `Unrelated topic ${index}`, topic_status: 'Open' }),
      });
      expect(response.status).toBe(201); await response.arrayBuffer();
    }
    peer.state.loseNextWriteResponse = true;
    expect((await run(gateway, transport)).ok).toBe(false);
    expect(peer.state.acceptedWrites).toBe(101);
    const expectedGuid = [...peer.state.topics.keys()].at(-1);
    const skips: number[] = [];
    const proxy = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', peer.baseUrl);
        skips.push(Number(url.searchParams.get('$skip') ?? 0));
        url.searchParams.set('$top', '100');
        const upstream = await fetch(url, { headers: { authorization: String(request.headers.authorization ?? '') } });
        response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(await upstream.text());
      })().catch(error => {
        console.warn('[Native BCF capped-page test] proxy failed', error);
        response.writeHead(500); response.end('Controlled proxy failed');
      });
    });
    await new Promise<void>((resolveReady, reject) => {
      proxy.once('error', reject); proxy.listen(0, '127.0.0.1', () => { proxy.removeListener('error', reject); resolveReady(); });
    });
    cleanup.push(() => new Promise<void>((resolveClosed, reject) => {
      proxy.closeAllConnections(); proxy.close(error => { if (error) reject(error); else resolveClosed(); });
    }));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Expected capped-page proxy TCP address');
    const capped: FetchTransport = (url, init) => fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
    const [entry] = await gateway.list();
    const checked = await gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants, networkTransport: capped });
    expect(skips).toEqual([0, 100, 101]);
    expect(checked.check).toMatchObject({ result: 'ambiguous', candidates: [{ guid: expectedGuid }] });
    await expect(gateway.confirmAbsent(entry.id)).rejects.toThrow(/absence/);
    expect((await run(gateway, transport)).ok).toBe(false); expect(peer.state.receivedWrites).toBe(101);
  });

  it('retains lost-response effects, refuses repeats and requires a checked GUID before explicit reconciliation', async () => {
    const { peer, dir, transport, gateway } = await fixture();
    peer.state.loseNextWriteResponse = true;
    expect((await run(gateway, transport)).ok).toBe(false);
    expect(peer.state.acceptedWrites).toBe(1);
    expect(peer.state.topics.size).toBe(1);
    const restored = createNativeBcfWriteGateway({ directory: dir });
    expect((await run(restored, transport)).ok).toBe(false);
    expect(peer.state.receivedWrites).toBe(1);
    const [entry] = await restored.list();
    expect(entry.state).toBe('uncertain');
    const guid = [...peer.state.topics.keys()][0];
    await expect(restored.reconcile(entry.id, guid)).rejects.toThrow(/candidate/);
    const checked = await restored.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants, networkTransport: transport });
    expect(checked.check).toMatchObject({ result: 'ambiguous', candidates: [{ guid }] });
    expect(checked.state).toBe('uncertain');
    expect(peer.state.receivedWrites).toBe(1);
    const receipt = await restored.reconcile(entry.id, guid);
    expect(receipt.receipt).toMatchObject({ remoteGuid: guid, evidence: 'reconciled' });
    expect((await createNativeBcfWriteGateway({ directory: dir }).list())[0].state).toBe('done');
    expect((await run(restored, transport)).ok).toBe(true); // a deliberate completed repeat is allowed
    expect(peer.state.acceptedWrites).toBe(2);
    expect(await disk(dir)).not.toContain(LOCAL_BCF_TOKEN);
  });

  it('keeps network denial distinct from unknown response and permits deliberate retry after definite refusal', async () => {
    const { peer, gateway, transport } = await fixture();
    expect((await run(gateway, transport, 'Duct hits beam', [])).ok).toBe(false);
    expect(peer.state.receivedWrites).toBe(0);
    expect((await gateway.list())[0]).toMatchObject({ state: 'failed', failure: { code: 'permission' } });
    peer.state.writesAllowed = false;
    expect((await run(gateway, transport)).ok).toBe(false);
    expect((await gateway.list())[1]).toMatchObject({ state: 'failed', failure: { code: 'permission', status: 403 } });
    peer.state.writesAllowed = true;
    expect((await run(gateway, transport)).ok).toBe(true);
    expect(peer.state.acceptedWrites).toBe(1);
  });

  it('actual literal node tokens are excluded from durable payloads without host secret enrollment', async () => {
    const { peer, dir, transport } = await fixture();
    const gateway = createNativeBcfWriteGateway({ directory: dir });
    expect((await run(gateway, transport, LOCAL_BCF_TOKEN)).ok).toBe(false);
    expect(peer.state.receivedWrites).toBe(0);
    expect((await gateway.list()).length).toBe(0);
  });

  it('a committed POST followed by a redirect refusal stays uncertain and cannot be repeated', async () => {
    const { peer, dir, gateway, transport } = await fixture();
    const redirect: FetchTransport = async (url, init) => {
      const result = await transport(url, init);
      return init.method === 'POST' && result.ok ? new Response(null, { status: 303, headers: { location: 'https://elsewhere.example.test/' } }) : result;
    };
    expect((await run(gateway, redirect)).ok).toBe(false);
    expect(peer.state.acceptedWrites).toBe(1);
    expect((await gateway.list())[0].state).toBe('uncertain');
    expect((await run(createNativeBcfWriteGateway({ directory: dir }), transport)).ok).toBe(false);
    expect(peer.state.receivedWrites).toBe(1);
  });

  it('requires explicit confirmed-absent release; failed/revoked checks cannot release an unresolved write', async () => {
    const { peer, gateway, transport } = await fixture();
    await expect(gateway.write(intent, async () => { throw new TypeError('connection failed'); })).rejects.toThrow(/unknown/);
    const [entry] = await gateway.list();
    await expect(gateway.confirmAbsent(entry.id)).rejects.toThrow(/check/);
    await expect(gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: [], networkTransport: transport })).rejects.toThrow();
    expect((await gateway.list())[0].check?.result).toBe('unavailable');
    await expect(gateway.confirmAbsent(entry.id)).rejects.toThrow(/check/);
    await gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants, confirmFullReadAccess: true, networkTransport: transport });
    expect((await gateway.list())[0].state).toBe('uncertain');
    expect((await run(gateway, transport)).ok).toBe(false);
    await gateway.confirmAbsent(entry.id);
    expect((await gateway.list())[0]).toMatchObject({ state: 'failed', failure: { code: 'confirmed-absent' } });
    expect((await run(gateway, transport)).ok).toBe(true);
    expect(peer.state.acceptedWrites).toBe(1);
  });

  it('a denied resumption settles the pending check before an older absence response and cannot be overwritten', async () => {
    const { gateway, transport } = await fixture();
    await expect(gateway.write(intent, async () => { throw new TypeError('lost'); })).rejects.toThrow();
    const [entry] = await gateway.list();
    let started!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    const slow: FetchTransport = async (url, init) => { started(); await waiting; return transport(url, init); };
    const earlier = gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants, confirmFullReadAccess: true, networkTransport: slow });
    await began;
    await expect(gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: [], networkTransport: transport })).rejects.toThrow();
    release(); await expect(earlier).rejects.toThrow(/EEXIST/);
    expect((await gateway.list())[0].check?.result).toBe('unavailable');
    await expect(gateway.confirmAbsent(entry.id)).rejects.toThrow(/check/);
  });

  it('a newer pending check wins the atomic transition and a stale absence decision cannot enable a send', async () => {
    const { gateway, dir, transport, peer } = await fixture();
    await expect(gateway.write(intent, async () => { throw new TypeError('lost'); })).rejects.toThrow();
    const [entry] = await gateway.list();
    await gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants, confirmFullReadAccess: true, networkTransport: transport });
    let paused!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { paused = resolve; });
    const publish = BcfPublicationStore.prototype.publish;
    // Delay the storage boundary to force the decision-read / exclusive-publication race.
    // Real persistence and real HTTP still run; no returned result is fabricated.
    const delayed = vi.spyOn(BcfPublicationStore.prototype, 'publish').mockImplementation(async function (this: BcfPublicationStore, ...args: Parameters<BcfPublicationStore['publish']>) {
      const [, value] = args;
      if (value !== null && typeof value === 'object' && 'settlement' in value) { paused(); await held; }
      return publish.apply(this, args);
    });
    try {
      const stale = gateway.confirmAbsent(entry.id);
      await began;
      const other = createNativeBcfWriteGateway({ directory: dir });
      await expect(other.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: [], networkTransport: transport })).rejects.toThrow();
      release();
      await expect(stale).rejects.toThrow();
      expect((await other.list())[0]).toMatchObject({ state: 'uncertain', check: { result: 'unavailable' } });
      expect((await run(other, transport)).ok).toBe(false);
      expect(peer.state.receivedWrites).toBe(0);
      expect(peer.state.acceptedWrites).toBe(0);
    } finally { release(); delayed.mockRestore(); }
  });

  it('a server ignoring topic pagination cannot certify absence', async () => {
    const dir = await directory();
    const gateway = createNativeBcfWriteGateway({ directory: dir });
    await expect(gateway.write(intent, async () => { throw new TypeError('lost'); })).rejects.toThrow();
    const [entry] = await gateway.list();
    let reads = 0;
    const repeating: FetchTransport = async () => {
      reads += 1;
      return new Response(JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ guid: `unrelated-${index}`, title: 'Other' }))), { status: 200 });
    };
    await expect(gateway.check(entry.id, { networkGrants: grants, networkTransport: repeating })).rejects.toThrow(/unavailable/);
    expect(reads).toBe(2);
    expect((await gateway.list())[0].check?.result).toBe('unavailable');
    await expect(gateway.confirmAbsent(entry.id)).rejects.toThrow(/check/);
  });

  it('claims concurrent identical attempts exclusively and refuses recovery while a sender is live', async () => {
    const { dir, gateway, transport, peer } = await fixture();
    let release!: () => void;
    let started!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const sending = new Promise<void>(resolve => { started = resolve; });
    let effects = 0;
    const first = gateway.write(intent, async () => { effects += 1; started(); await paused; return { guid: 'real-guid' }; });
    await sending;
    const other = createNativeBcfWriteGateway({ directory: dir });
    const [entry] = await other.list();
    await expect(other.write(intent, async () => { effects += 1; return { guid: 'duplicate' }; })).rejects.toThrow(/unknown outcome/);
    await expect(other.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants, networkTransport: transport })).rejects.toThrow(/active/);
    await expect(other.reconcile(entry.id, 'arbitrary')).rejects.toThrow(/active/);
    expect(peer.state.receivedWrites).toBe(0);
    release(); await first;
    expect(effects).toBe(1);
  });

  it('refuses unavailable storage and interrupted/malformed persisted records before calling send', async () => {
    const dir = await directory();
    const unavailable = join(dir, 'file');
    await writeFile(unavailable, 'not a directory');
    let effects = 0;
    const send = async () => { effects += 1; return { guid: 'effect' }; };
    await expect(createNativeBcfWriteGateway({ directory: unavailable }).write(intent, send)).rejects.toThrow();
    const gateway = createNativeBcfWriteGateway({ directory: dir });
    await gateway.list();
    const namespace = await namespaceDir(dir);
    const digest = intentDigest(intent);
    await mkdir(join(namespace, digest.slice(0, 2), digest), { recursive: true });
    await writeFile(join(namespace, digest.slice(0, 2), digest, `${digest}-1.intent.json`), '{"interrupted":');
    await expect(gateway.write(intent, send)).rejects.toThrow();
    expect(effects).toBe(0);
  });

  it.skipIf(process.platform !== 'linux')('ancestor directory-fsync refusal prevents HTTP effects and preserves actual prior journal bytes (#7374)', async () => {
    const { peer, dir, gateway, transport } = await fixture();
    expect((await run(gateway, transport)).ok).toBe(true);
    expect(peer.state.acceptedWrites).toBe(1);
    const [entry] = await gateway.list();
    const receiptPath = join(await entryDir(dir, entry.id), `${entry.id}.outcome.json`);
    const receiptBytes = await readFile(receiptPath, 'utf8');
    const probe = await open(dir, 'r');
    const prototype: FileHandle = Object.getPrototypeOf(probe);
    const sync = prototype.sync;
    let ancestorFailures = 0;
    const fault = vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
      const actualDirectory = await readlink(`/proc/self/fd/${this.fd}`);
      if (actualDirectory === dir) {
        ancestorFailures += 1;
        throw Object.assign(new Error('Injected ancestor fsync EIO'), { code: 'EIO' });
      }
      return sync.call(this);
    });
    try {
      const firstUse = createNativeBcfWriteGateway({ directory: dir, namespace: 'new-first-use' });
      expect((await run(firstUse, transport, 'Must not reach server')).ok).toBe(false);
      expect(ancestorFailures).toBe(1);
      expect(peer.state.receivedWrites).toBe(1);
      expect(peer.state.acceptedWrites).toBe(1);
      expect(await readFile(receiptPath, 'utf8')).toBe(receiptBytes);
    } finally { fault.mockRestore(); await probe.close(); }
    expect((await run(createNativeBcfWriteGateway({ directory: dir, namespace: 'new-first-use' }),
      transport, 'Must not reach server')).ok).toBe(true);
    expect(peer.state.acceptedWrites).toBe(2);
  });

  it('pages actual retained effects without dropping distinct receipts and recovers old generations (#7374)', async () => {
    const { peer, dir, transport, gateway } = await fixture();
    for (const title of ['First distinct effect', 'Second distinct effect', 'First distinct effect']) {
      expect((await run(gateway, transport, title)).ok).toBe(true);
    }
    expect(peer.state.acceptedWrites).toBe(3);
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await gateway.listPage({ limit: 1, cursor });
      for (const entry of page.entries) {
        expect(ids.has(entry.id)).toBe(false);
        ids.add(entry.id);
        expect(entry.receipt?.remoteGuid).toBeTruthy();
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids.size).toBe(3);
    const restarted = createNativeBcfWriteGateway({ directory: dir });
    const oldest = [...ids].find(id => id.endsWith('-1'));
    if (!oldest) throw new Error('Expected original retained generation');
    await expect(restarted.reconcile(oldest, 'untrusted-guid')).rejects.toThrow(/already settled/);
    expect(peer.state.receivedWrites).toBe(3);
    expect((await restarted.list()).map(entry => entry.id).sort()).toEqual([...ids].sort());
  });

  it('full bucket refuses before an HTTP effect while its prior receipt remains readable (#7374)', async () => {
    const { peer, dir, transport, gateway } = await fixture();
    expect((await run(gateway, transport)).ok).toBe(true);
    expect(peer.state.acceptedWrites).toBe(1);
    const [original] = await gateway.list();
    const prefix = original.id.slice(0, 2);
    const bucket = join(await namespaceDir(dir), prefix);
    // Immutable capacity-slot byte layout is the compatibility contract; no historical receipt is deleted.
    for (let slot = 1; slot < 4096; slot += 1) {
      const digest = prefix + slot.toString(16).padStart(62, '0');
      await writeFile(join(bucket, `slot-${slot}.json`), JSON.stringify({ version: 2, digest }));
    }
    let title = '', digest = '';
    for (let trial = 0; trial < 10000; trial += 1) {
      title = `Capacity trial ${trial}`;
      digest = intentDigest({ ...intent, payload: { title, topic_status: 'Open' } });
      if (digest.startsWith(prefix)) break;
    }
    expect(digest.startsWith(prefix)).toBe(true);
    expect((await run(gateway, transport, title)).ok).toBe(false);
    expect(peer.state.receivedWrites).toBe(1);
    expect(peer.state.acceptedWrites).toBe(1);
    expect((await readdir(bucket)).length).toBe(4097); // 4096 slots plus original digest directory.
    const restored = createNativeBcfWriteGateway({ directory: dir });
    const page = await restored.listPage({ limit: 10 });
    expect(page.entries).toEqual([original]);
    expect(page.nextCursor).toBeUndefined();
    await expect(restored.reconcile(original.id, 'arbitrary')).rejects.toThrow(/already settled/);
    expect(peer.state.receivedWrites).toBe(1);
  }, 30000);

  it('reserves settlement after the bounded recovery checks and retains generation receipts (#7374)', async () => {
    const { peer, gateway, transport } = await fixture();
    peer.state.loseNextWriteResponse = true;
    expect((await run(gateway, transport)).ok).toBe(false);
    expect(peer.state.acceptedWrites).toBe(1);
    peer.state.topics.clear();
    const [entry] = await gateway.list();
    let requests = 0;
    const counting: FetchTransport = (url, init) => { requests += 1; return transport(url, init); };
    for (let check = 0; check < 16; check += 1) {
      expect((await gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants, confirmFullReadAccess: true,
        networkTransport: counting })).check?.result).toBe('absent');
    }
    expect(requests).toBe(16);
    expect((await gateway.confirmAbsent(entry.id)).failure?.code).toBe('confirmed-absent');
    expect((await run(gateway, transport)).ok).toBe(true);
    expect(peer.state.receivedWrites).toBe(2);
    expect((await gateway.list()).map(item => item.state)).toEqual(['failed', 'done']);
  });

  it('advances completed unavailable epoch16 to an authorized successful check17 without another create (#7374)', async () => {
    const { peer, dir, gateway, transport } = await fixture();
    peer.state.loseNextWriteResponse = true;
    expect((await run(gateway, transport)).ok).toBe(false);
    expect(peer.state.acceptedWrites).toBe(1);
    const [entry] = await gateway.list();
    let requests = 0, obscure = true;
    const read: FetchTransport = async (url, init) => {
      requests += 1;
      const response = await transport(url, init);
      if (!obscure) return response;
      const rows: unknown = await response.json();
      if (!Array.isArray(rows)) throw new Error('Expected independently retained topic enumeration');
      return new Response(JSON.stringify(rows.map(row => ({ ...row, title: 'Server normalized free text' }))), {
        status: response.status, headers: { 'content-type': 'application/json' },
      });
    };
    for (let check = 0; check < 16; check += 1) {
      expect((await gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants,
        networkTransport: read })).check?.result).toBe('unavailable');
    }
    obscure = false;
    const restored = createNativeBcfWriteGateway({ directory: dir });
    const originalPublish = BcfPublicationStore.prototype.publish;
    const emptyEpoch = vi.spyOn(BcfPublicationStore.prototype, 'publish').mockImplementation(function(this: BcfPublicationStore, ...args: Parameters<BcfPublicationStore['publish']>) {
      const [filename] = args;
      if (filename === `${entry.id}.check-17.json`) throw new Error('Interrupted after epoch marker');
      return originalPublish.apply(this, args);
    });
    try {
      await expect(restored.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants,
        networkTransport: read })).rejects.toThrow(/Interrupted/);
    } finally { emptyEpoch.mockRestore(); }
    expect((await createNativeBcfWriteGateway({ directory: dir }).list())[0].check?.result).toBe('unavailable');
    const checked = await restored.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants, networkTransport: read });
    const guid = [...peer.state.topics.keys()][0];
    expect(requests).toBe(34); // Every complete enumeration checks the populated and empty next page.
    expect(checked.check?.candidates).toEqual([{ guid }]);
    expect((await restored.reconcile(entry.id, guid)).receipt?.remoteGuid).toBe(guid);
    expect(peer.state.receivedWrites).toBe(1);
    const epochs = join(await entryDir(dir, entry.id), `${entry.id}.epochs`);
    expect((await readdir(epochs)).sort()).toEqual(['1', '2']);
    expect(await readdir(join(epochs, '1'))).toContain(`${entry.id}.checked-16.json`);
  });

  it('resumes interrupted check16 in fresh hosts and exclusive results preserve the real effect (#7374)', async () => {
    const { peer, dir, gateway, transport } = await fixture();
    peer.state.loseNextWriteResponse = true;
    expect((await run(gateway, transport)).ok).toBe(false);
    expect(peer.state.acceptedWrites).toBe(1);
    const [entry] = await gateway.list();
    for (let check = 0; check < 15; check += 1) {
      await expect(gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: [],
        networkTransport: transport })).rejects.toThrow(/unavailable/);
    }
    const publish = BcfPublicationStore.prototype.publish;
    const fault = vi.spyOn(BcfPublicationStore.prototype, 'publish').mockImplementation(function(this: BcfPublicationStore, ...args: Parameters<BcfPublicationStore['publish']>) {
      const [filename] = args;
      if (filename === `${entry.id}.checked-16.json`) throw new Error('Interrupted before checked proof persistence');
      return publish.apply(this, args);
    });
    try {
      await expect(gateway.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants,
        networkTransport: transport })).rejects.toThrow(/Interrupted/);
    } finally { fault.mockRestore(); }
    const restored = createNativeBcfWriteGateway({ directory: dir });
    const competing = createNativeBcfWriteGateway({ directory: dir });
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const simultaneous: FetchTransport = async (url, init) => {
      const response = await transport(url, init);
      if (++arrivals === 2) release();
      await barrier; return response;
    };
    const results = await Promise.allSettled([restored, competing].map(host => host.check(entry.id, {
      token: LOCAL_BCF_TOKEN, networkGrants: grants, networkTransport: simultaneous,
    })));
    expect(arrivals).toBe(4); // Two resumers each complete the populated and empty next page.
    expect(results.filter(result => result.status === 'fulfilled').length).toBe(1);
    expect(results.filter(result => result.status === 'rejected').length).toBe(1);
    const guid = [...peer.state.topics.keys()][0];
    expect((await restored.list())[0].check?.candidates).toEqual([{ guid }]);
    expect((await restored.reconcile(entry.id, guid)).receipt?.remoteGuid).toBe(guid);
    expect(peer.state.receivedWrites).toBe(1);
    const first = join(await entryDir(dir, entry.id), `${entry.id}.epochs`, '1');
    expect(await readdir(first)).toContain(`${entry.id}.checked-16.json`);
    expect(await readdir(first)).not.toContain(`${entry.id}.check-17.json`);
  });

  it('refuses generation257 before sending while all256 real-effect receipts remain readable (#7374)', async () => {
    const { peer, gateway, transport } = await fixture();
    for (let generation = 1; generation <= 256; generation += 1) expect((await run(gateway, transport)).ok).toBe(true);
    expect(peer.state.acceptedWrites).toBe(256);
    expect((await run(gateway, transport)).ok).toBe(false);
    expect(peer.state.receivedWrites).toBe(256);
    const entries = await gateway.list();
    expect(entries.length).toBe(256);
    expect(new Set(entries.map(item => item.receipt?.remoteGuid)).size).toBe(256);
    await expect(gateway.reconcile(entries[0].id, 'arbitrary')).rejects.toThrow(/already settled/);
    expect(peer.state.receivedWrites).toBe(256);
  }, 30000);

  it('revalidates an early receipt before allowing another real effect (#7637)', async () => {
    const { peer, dir, gateway, transport } = await fixture();
    for (let generation = 1; generation <= 9; generation += 1) {
      expect((await run(gateway, transport)).ok).toBe(true);
    }
    const entries = await gateway.list();
    const first = entries.find(entry => entry.id.endsWith('-1'));
    expect(first).toBeDefined();
    if (!first) throw new Error('Missing first retained publication');
    const path = join(await entryDir(dir, first.id), `${first.id}.outcome.json`);
    const outcome = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    outcome.id = 'tampered-predecessor';
    await writeFile(path, JSON.stringify(outcome));

    await expect(gateway.list()).rejects.toThrow(/outcome/);
    expect((await run(gateway, transport)).ok).toBe(false);
    expect(peer.state.receivedWrites).toBe(9);
    expect(peer.state.acceptedWrites).toBe(9);
  });

  it('refuses observed receipt growth between stat and read before another effect (#7637)', async () => {
    const { peer, dir, gateway, transport } = await fixture();
    expect((await run(gateway, transport)).ok).toBe(true);
    const [entry] = await gateway.list();
    const path = join(await entryDir(dir, entry.id), `${entry.id}.outcome.json`);
    const original = await readFile(path, 'utf8');
    const probe = await open(path, 'r');
    const identity = await probe.stat();
    const prototype: FileHandle = Object.getPrototypeOf(probe);
    const stat = prototype.stat;
    let grew = false;
    const fault = vi.spyOn(prototype, 'stat').mockImplementation(async function(this: FileHandle, ...options: Parameters<FileHandle['stat']>) {
      const result = await stat.apply(this, options);
      if (!grew && result.ino === identity.ino && result.dev === identity.dev) {
        grew = true;
        // Valid JSON whitespace defeats a size-limited read without its sentinel.
        await writeFile(path, `${original}\n`);
      }
      return result;
    });
    try {
      expect((await run(gateway, transport)).ok).toBe(false);
      expect(grew).toBe(true);
      expect(peer.state.receivedWrites).toBe(1);
    } finally {
      fault.mockRestore();
      await probe.close();
    }
    // A fresh read can validate the complete, still-valid receipt normally.
    expect((await run(gateway, transport)).ok).toBe(true);
    expect(peer.state.receivedWrites).toBe(2);
  });

  it('an outcome-persistence refusal keeps the sending intent unresolved and cannot report success', async () => {
    const dir = await directory();
    const gateway = createNativeBcfWriteGateway({ directory: dir });
    let effects = 0;
    await expect(gateway.write(intent, async () => {
      effects += 1;
      const [entry] = await gateway.list();
      await mkdir(join(await entryDir(dir, entry.id), `${entry.id}.outcome.json`));
      return { guid: 'committed-guid' };
    })).rejects.toThrow();
    await expect(createNativeBcfWriteGateway({ directory: dir }).write(intent, async () => {
      effects += 1; return { guid: 'duplicate' };
    })).rejects.toThrow();
    expect(effects).toBe(1);
  });

  it('rejects tampered identity, contradictory definite outcomes, and symlinked imported records', async () => {
    const dir = await directory();
    const gateway = createNativeBcfWriteGateway({ directory: dir });
    await expect(gateway.write(intent, async () => { throw new TypeError('lost'); })).rejects.toThrow();
    const [entry] = await gateway.list();
    const namespace = await entryDir(dir, entry.id);
    const path = join(namespace, `${entry.id}.outcome.json`);
    const original = await readFile(path, 'utf8');
    const tampered = JSON.parse(original) as Record<string, unknown>;
    tampered.state = 'failed';
    await writeFile(path, JSON.stringify(tampered));
    await expect(gateway.list()).rejects.toThrow(/uncertain failure/);
    await writeFile(path, original);
    const attemptPath = join(namespace, `${entry.id}.intent.json`);
    const attempt = JSON.parse(await readFile(attemptPath, 'utf8')) as { intent: { projectId: string } };
    attempt.intent.projectId = 'other';
    await writeFile(attemptPath, JSON.stringify(attempt));
    await expect(gateway.list()).rejects.toThrow(/identity mismatch/);
    await rm(path); await symlink(attemptPath, path);
    await expect(gateway.list()).rejects.toThrow();
  });

  it('recovery server errors cannot echo credentials into caller errors or durable state', async () => {
    const dir = await directory();
    const gateway = createNativeBcfWriteGateway({ directory: dir });
    await expect(gateway.write(intent, async () => { throw new TypeError('lost'); })).rejects.toThrow();
    const [entry] = await gateway.list();
    const token = 'recovery-bearer-secret';
    const transport: FetchTransport = async () => new Response(JSON.stringify({ message: `echo ${token}` }), { status: 401 });
    try {
      await gateway.check(entry.id, { token, networkGrants: grants, networkTransport: transport });
      throw new Error('check unexpectedly succeeded');
    } catch (error) {
      expect(String(error)).not.toContain(token);
      expect(error instanceof Error && error.cause).toBeFalsy();
    }
    expect(await disk(dir)).not.toContain(token);
    expect((await gateway.list())[0].check?.result).toBe('unavailable');
  });

  it('never persists known secrets, bearer text, credential URLs or raw credential-bearing error messages', async () => {
    const dir = await directory();
    const token = 'unique-access-secret';
    const gateway = createNativeBcfWriteGateway({ directory: dir, secrets: [token] });
    let effects = 0;
    for (const bad of [{ ...intent, payload: { title: token } }, { ...intent, baseUrl: 'https://user:password@bcf.example.test/bcf' },
      { ...intent, payload: { title: 'Authorization: Bearer abcdef' } }]) {
      await expect(gateway.write(bad, async () => { effects += 1; return { guid: 'x' }; })).rejects.toThrow();
    }
    await expect(gateway.write(intent, async () => { throw new BcfApiError(`server echoes ${token}`, { status: 401, url: baseUrl }); })).rejects.toThrow();
    expect(await disk(dir)).not.toContain(token);
    expect(effects).toBe(0);
    await expect(createNativeBcfWriteGateway({ directory: dir, secrets: ['Duct hits beam'] }).list()).rejects.toThrow(/credentials/);
  });
});
