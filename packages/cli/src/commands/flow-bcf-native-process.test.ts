/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7374: a killed actual CLI Flow host leaves only durable intent, not a caught failure.
import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { parseCapabilities } from '@ifc-lite/extensions';
import { createNativeBcfWriteGateway } from '@ifc-lite/flow-nodes/bcf-publication-node';
import { LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN, startLocalBcfServer } from '../../../../apps/viewer/src/test/bcf-http-server.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

it.each([['topic', 'exact'], ['topic', 'trimmed'], ['topic', 'rewritten'], ['topic', 'omitted'],
  ['comment', 'trimmed'], ['comment', 'omitted'], ['topic', 'foreign-owner'], ['topic', 'reused-pid']] as const)('kills a native host after retained %s commit (%s text), and blocks fresh-process duplicate (#7374)', async (operation, mode) => {
  const peer = await startLocalBcfServer();
  cleanup.push(peer.close);
  const field = operation === 'comment' ? 'comment' : 'title';
  let topicGuid: string | undefined;
  if (operation === 'comment') {
    const created = await fetch(`${peer.baseUrl}/2.1/projects/${LOCAL_BCF_PROJECT}/topics`, {
      method: 'POST', headers: { authorization: `Bearer ${LOCAL_BCF_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Parent topic', topic_status: 'Open' }),
    });
    expect(created.status).toBe(201); await created.arrayBuffer();
    topicGuid = [...peer.state.topics.keys()][0];
  }
  const initialWrites = peer.state.acceptedWrites;
  const directory = await mkdtemp(join(tmpdir(), 'bcf-native-killed-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  // Root paths resolve types to .d.ts; a native process must use real package exports.
  const tsxConfig = join(directory, 'tsx.json');
  await writeFile(tsxConfig, JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', paths: {} } }));
  let committed!: () => void;
  let rejected!: (error: unknown) => void;
  const effect = new Promise<void>((resolve, reject) => { committed = resolve; rejected = reject; });
  let hold = true;
  const proxy = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      let posted = Buffer.concat(chunks);
      if ((mode === 'trimmed' || mode === 'rewritten') && request.method === 'POST') {
        const submitted: unknown = JSON.parse(posted.toString('utf8'));
        if (!submitted || typeof submitted !== 'object' || !(field in submitted)) {
          throw new Error('Expected actual Flow topic payload');
        }
        const submittedText: unknown = Reflect.get(submitted, field);
        expect(submittedText).toBe(mode === 'trimmed' ? '  Duct hits beam  ' : 'Duct hits beam');
        if (typeof submittedText !== 'string') throw new Error('Expected actual Flow free text');
        posted = Buffer.from(JSON.stringify({ ...submitted, [field]: mode === 'trimmed' ? submittedText.trim() : 'Server rewrote title' }));
      }
      const result = await fetch(new URL(request.url ?? '/', peer.baseUrl), { method: request.method,
        headers: { authorization: String(request.headers.authorization ?? ''), 'content-type': 'application/json' },
        ...(request.method === 'POST' ? { body: posted } : {}) });
      let body = await result.text();
      if (mode === 'omitted' && request.method === 'GET') {
        const listed: unknown = JSON.parse(body);
        if (!Array.isArray(listed)) throw new Error('Expected actual server topic enumeration');
        body = JSON.stringify(listed.map((topic: unknown) => {
          if (!topic || typeof topic !== 'object') throw new Error('Expected retained server topic');
          return { ...topic, [field]: undefined };
        }));
      }
      if (request.method === 'POST' && result.status === 201 && hold) {
        committed(); // Peer has retained the effect, but this server sends no response to the host.
        return;
      }
      response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(body);
    })().catch(error => { rejected(error); response.writeHead(500); response.end('Controlled proxy failed'); });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Expected controlled TCP address');
  const proxyUrl = `http://127.0.0.1:${address.port}/bcf`;
  cleanup.push(async () => { proxy.closeAllConnections(); await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); });
  const config = { directory, baseUrl: proxyUrl, projectId: LOCAL_BCF_PROJECT, token: LOCAL_BCF_TOKEN,
    operation, mode, topicGuid, title: mode === 'trimmed' ? '  Duct hits beam  ' : 'Duct hits beam',
    model: fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)) };
  const start = () => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../test/bcf-native-process.mjs', import.meta.url)), JSON.stringify(config)],
      { env: { ...process.env, IFCLITE_BCF_OUTBOX_DIR: directory, TSX_TSCONFIG_PATH: tsxConfig }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    const complete = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; errors: string }>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Native host exceeded deadline: ${errors}`)); }, 20_000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, output, errors }); });
    });
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await complete; });
    return { child, complete };
  };
  const first = start();
  await Promise.race([effect, first.complete.then(result => { throw new Error(`Host exited before retained commit (${result.code}, ${result.signal}): ${result.errors} ${result.output}`); })]);
  expect(peer.state.acceptedWrites).toBe(initialWrites + 1);
  expect(peer.state.topics.size).toBe(1);
  const gateway = createNativeBcfWriteGateway({ directory });
  const [sending] = await gateway.list();
  expect(sending).toBeDefined(); // The retained real POST must already have a durable intent.
  expect(sending.state).toBe('sending');
  expect(sending.receipt).toBeUndefined();
  expect(sending.failure).toBeUndefined();
  const grants = parseCapabilities(['network.fetch:bcf.example.test']);
  if (!grants.ok) throw new Error('Invalid controlled grant');
  const transport = (url: URL, init: RequestInit) => fetch(new URL(url.pathname + url.search, proxyUrl), init);
  await expect(gateway.check(sending.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants.value,
    networkTransport: transport, confirmOwnerStopped: true })).rejects.toThrow(/owner is still active/);
  expect(peer.state.acceptedWrites).toBe(initialWrites + 1);
  first.child.kill('SIGKILL');
  expect((await first.complete).signal).toBe('SIGKILL');
  hold = false;
  if (mode === 'foreign-owner' || mode === 'reused-pid') {
    const namespace = (await readdir(directory))[0];
    const path = join(directory, namespace, 'v2', sending.id.slice(0, 2), sending.id.slice(0, 64), `${sending.id}.intent.json`);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    // Compatibility adversaries retain the actual killed sender's intent and instance identity.
    if (mode === 'foreign-owner') stored.owner.host = 'f'.repeat(64);
    else stored.owner.pid = process.pid; // Real live PID, different starttime from killed child.
    await writeFile(path, JSON.stringify(stored));
  }
  const duplicate = await start().complete;
  expect(duplicate.code, duplicate.errors).toBe(0);
  expect(JSON.parse(duplicate.output.trim().split('\n').at(-1) ?? '')).toMatchObject({ ok: false });
  expect(peer.state.receivedWrites).toBe(initialWrites + 1);
  expect(peer.state.acceptedWrites).toBe(initialWrites + 1);
  const [restored] = await gateway.list();
  expect(restored.state).toBe('uncertain');
  expect(restored.failure).toBeUndefined(); // No catch/outcome persisted: recovery follows the dead owner.
  if (mode === 'foreign-owner') {
    expect(restored.ownerStatus).toBe('unknown');
    await expect(gateway.check(restored.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants.value,
      networkTransport: transport })).rejects.toThrow(/owner is unknown/);
  } else expect(restored.ownerStatus).toBe('dead');
  const checked = await gateway.check(restored.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants.value,
    networkTransport: transport, confirmOwnerStopped: mode === 'foreign-owner' });
  const retainedTopic = peer.state.topics.get(topicGuid ?? [...peer.state.topics.keys()][0]);
  if (!retainedTopic) throw new Error('Expected retained topic');
  const retained = operation === 'comment' ? retainedTopic.comments[0] : retainedTopic.topic;
  expect(Reflect.get(retained, field)).toBe(mode === 'rewritten' ? 'Server rewrote title' : 'Duct hits beam');
  const guid = retained.guid;
  const recordedText = 'title' in restored.intent.payload ? restored.intent.payload.title : restored.intent.payload.comment;
  expect(recordedText).toBe(config.title);
  if (mode === 'rewritten' || mode === 'omitted') {
    expect(checked.check).toMatchObject({ result: 'unavailable', candidates: [] });
    await expect(gateway.confirmAbsent(restored.id)).rejects.toThrow(/check/);
    await expect(gateway.reconcile(restored.id, guid)).rejects.toThrow(/candidate/);
    const blocked = await start().complete;
    expect(blocked.code, blocked.errors).toBe(0);
    expect(JSON.parse(blocked.output.trim().split('\n').at(-1) ?? '')).toMatchObject({ ok: false });
    expect(peer.state.acceptedWrites).toBe(initialWrites + 1);
    return;
  }
  expect(checked.check?.result).toBe('ambiguous');
  expect(checked.check?.candidates).toEqual([{ guid }]);
  await expect(gateway.confirmAbsent(restored.id)).rejects.toThrow(/absence/);
  const blocked = await start().complete;
    expect(blocked.code, blocked.errors).toBe(0);
    expect(JSON.parse(blocked.output.trim().split('\n').at(-1) ?? '')).toMatchObject({ ok: false });
  expect(peer.state.acceptedWrites).toBe(initialWrites + 1);
  await gateway.reconcile(restored.id, guid);
  expect((await createNativeBcfWriteGateway({ directory }).list())[0].receipt).toMatchObject({ remoteGuid: guid, evidence: 'reconciled' });
  expect(peer.state.acceptedWrites).toBe(initialWrites + 1);
}, 30_000);
