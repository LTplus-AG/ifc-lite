/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7374: fresh real CLI processes share intent while the independent HTTP peer retains effects.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { FlowDocument } from '@ifc-lite/flow';
import { startLocalBcfServer, LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN } from '../../../../apps/viewer/src/test/bcf-http-server.js';

const here = dirname(fileURLToPath(import.meta.url));
const preload = resolve(here, '../test/bcf-publication-preload.mjs');
const executable = resolve(here, '../../dist/index.js');
const model = resolve(here, '../../../../apps/viewer/public/samples/hello-wall.ifc');
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function generatedJournalBytes(directory: string): Promise<string> {
  const files = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  const parts: string[] = [];
  for (const file of files) {
    const path = join(directory, file.name);
    parts.push(file.isDirectory() ? await generatedJournalBytes(path) : await readFile(path, 'utf8'));
  }
  return parts.join('\n');
}

async function setup(options: Parameters<typeof startLocalBcfServer>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ifc-cli-bcf-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const peer = await startLocalBcfServer(options);
  cleanup.push(peer.close);
  const outbox = join(directory, 'outbox');
  const graph = join(directory, 'write.flow.json');
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', preload, executable, 'flow', ...args], {
      env: { ...process.env, IFCLITE_BCF_OUTBOX_DIR: outbox, IFCLITE_TEST_BCF_PEER: peer.baseUrl, BCF_TOKEN: options.token ?? LOCAL_BCF_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI flow ${args[0]} subprocess exceeded 15 second deadline`));
    }, 15_000);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { clearTimeout(deadline); reject(error); });
    child.on('close', code => { clearTimeout(deadline); done({ code, stdout, stderr }); });
  });
  const document = (type: string, params: Record<string, string>): FlowDocument => ({
    flowVersion: 1, id: 'durable-cli', name: 'durable-cli',
    capabilities: ['network.fetch:bcf-peer.test', 'secret.read:BCF_TOKEN'], inputs: [], outputs: [], edges: [],
    nodes: [{ id: 'write', type, params: { baseUrl: 'https://bcf-peer.test/bcf', projectId: LOCAL_BCF_PROJECT,
      token: '{{secret:BCF_TOKEN}}', ...params } }],
  });
  const write = async (type: string, params: Record<string, string>) => {
    await writeFile(graph, JSON.stringify(document(type, params)));
    return run(['run', graph, model, '--no-tracking', '--json']);
  };
  const entries = async () => {
    const listed = await run(['bcf', 'list']);
    expect(listed.code, listed.stderr).toBe(0);
    return JSON.parse(listed.stdout) as Array<{ id: string; state: string; receipt?: { remoteGuid: string }; check?: { result?: string; fullReadAccessConfirmed?: true; candidates: Array<{ guid: string }> } }>;
  };
  return { peer, directory, outbox, graph, document, run, write, entries };
}

it.each(['literal', 'Player'] as const)('native %s id bearer preserves topic/comment receipts across real CLI restarts (#7374)', async source => {
  const { peer, graph, document, run, write, entries } = await setup({ token: 'id', guidPrefix: 'cafe' });
  const doc: FlowDocument = { ...document('bcf.createTopic', { title: 'Clean topic', token: source === 'literal' ? 'id' : 'unused-default' }),
    inputs: source === 'Player' ? [{ nodeId: 'write', param: 'token', label: 'BCF token', kind: 'scalar' }] : [],
    nodes: [...document('bcf.createTopic', { title: 'Clean topic', token: source === 'literal' ? 'id' : 'unused-default' }).nodes,
      { id: 'comment', type: 'bcf.addComment', params: { baseUrl: 'https://bcf-peer.test/bcf', projectId: LOCAL_BCF_PROJECT,
        token: 'id', comment: 'Clean relation' } }],
    edges: [{ from: ['write', 'guids'], to: ['comment', 'topicGuid'] }],
    outputs: [{ nodeId: 'comment', port: 'created', label: 'Comment' }] };
  await writeFile(graph, JSON.stringify(doc));
  const result = await run(['run', graph, model, '--no-tracking', '--json',
    ...(source === 'Player' ? ['--input', 'write.token=id'] : [])]);
  expect(peer.state.acceptedWrites).toBe(2);
  const retained = [...peer.state.topics.values()][0];
  expect(retained.comments[0].topic_guid).toBe(retained.topic.guid);
  expect(result.code, result.stderr).toBe(0);
  const listed = await entries();
  expect(listed.map(entry => entry.receipt?.remoteGuid).sort()).toEqual([retained.topic.guid, retained.comments[0].guid].sort());

  peer.state.loseNextWriteResponse = true;
  expect((await write('bcf.createTopic', { title: 'Lost relation', token: 'id' })).code).toBe(1);
  expect(peer.state.acceptedWrites).toBe(3);
  const lostGuid = [...peer.state.topics.keys()].at(-1)!;
  expect((await write('bcf.createTopic', { title: 'Lost relation', token: 'id' })).code).toBe(1);
  const uncertain = (await entries()).find(entry => entry.state === 'uncertain')!;
  expect((await run(['bcf', 'check', uncertain.id, '--allow-host', 'bcf-peer.test', '--token-env', 'BCF_TOKEN'])).code).toBe(0);
  expect((await entries()).find(entry => entry.id === uncertain.id)?.check?.candidates).toEqual([{ guid: lostGuid }]);
  expect((await run(['bcf', 'reconcile', uncertain.id, '--guid', lostGuid])).code).toBe(0);
  expect((await entries()).find(entry => entry.id === uncertain.id)?.receipt?.remoteGuid).toBe(lostGuid);
  expect(peer.state.receivedWriteAttempts).toBe(3);
}, 60_000);

it.each([['bcf.createTopic', 'literal'], ['bcf.createTopic', 'Player'],
  ['bcf.addComment', 'literal'], ['bcf.addComment', 'Player']] as const)(
  'redacts actual successful %s response bearer echo from %s credentials (#7374)', async (type, source) => {
    const token = source === 'Player' ? 'xy!' : 'quote"slash\\credential';
    const { peer, outbox, graph, document, run, write, entries } = await setup({ token, echoWriteToken: true });
    let topicGuid: string | undefined;
    if (type === 'bcf.addComment') {
      expect((await write('bcf.createTopic', { title: 'Echo test parent', token })).code).toBe(0);
      topicGuid = [...peer.state.topics.keys()][0];
    }
    const params: Record<string, string> = type === 'bcf.createTopic' ? { title: 'Safe topic' } : { topicGuid: topicGuid!, comment: 'Safe comment' };
    const doc: FlowDocument = { ...document(type, { ...params, token: source === 'literal' ? token : 'unused-default' }),
      inputs: source === 'Player' ? [{ nodeId: 'write', param: 'token', label: 'BCF token', kind: 'scalar' }] : [],
      outputs: [{ nodeId: 'write', port: type === 'bcf.createTopic' ? 'topics' : 'created', label: 'Published object' }] };
    await writeFile(graph, JSON.stringify(doc));
    const result = await run(['run', graph, model, '--no-tracking', '--json',
      ...(source === 'Player' ? ['--input', `write.token=${token}`] : [])]);
    expect(peer.state.acceptedWrites).toBe(type === 'bcf.createTopic' ? 1 : 2);
    expect(peer.state.receivedWrites).toBe(type === 'bcf.createTopic' ? 1 : 2);
    expect(result.code, result.stderr).toBe(0);
    const retained = peer.state.topics.get(topicGuid ?? [...peer.state.topics.keys()][0]);
    if (!retained) throw new Error('Expected independently retained BCF effect');
    const guid = type === 'bcf.createTopic' ? retained.topic.guid : retained.comments[0].guid;
    expect(type === 'bcf.createTopic' ? retained.topic.title : retained.comments[0].comment).toBe(type === 'bcf.createTopic' ? 'Safe topic' : 'Safe comment');
    expect(result.stdout).toContain('Server echoed [REDACTED]');
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(result.stdout + result.stderr).not.toContain(JSON.stringify(token).slice(1, -1));
    expect(await entries()).toContainEqual(expect.objectContaining({ state: 'done', receipt: expect.objectContaining({ remoteGuid: guid }) }));
    const journal = await generatedJournalBytes(outbox);
    expect(journal).not.toContain(token);
    expect(journal).not.toContain(JSON.stringify(token).slice(1, -1));
  }, 60_000);

it('recovers topics across fresh CLI processes without duplicate sends (#7374)', async () => {
  const { peer, run, write, entries } = await setup();
  peer.state.loseNextWriteResponse = true;
  expect((await write('bcf.createTopic', { title: 'Restarted CLI topic' })).code).toBe(1);
  const topicGuid = [...peer.state.topics.keys()][0];
  expect(topicGuid).toBeDefined();
  const restarted = await write('bcf.createTopic', { title: 'Restarted CLI topic' });
  expect({ exitCode: restarted.code, serverEffects: peer.state.receivedWrites }).toEqual({ exitCode: 1, serverEffects: 1 });
  const [topicIntent] = await entries();
  expect(topicIntent.state).toBe('uncertain');
  // A revoked host grant neither reaches the recorded server nor resolves the intent.
  expect((await run(['bcf', 'check', topicIntent.id, '--allow-host', 'denied.example', '--token-env', 'BCF_TOKEN'])).code).toBe(1);
  expect((await entries())[0].state).toBe('uncertain');
  expect((await run(['bcf', 'reconcile', topicIntent.id, '--guid', topicGuid])).code).toBe(1);
  expect((await run(['bcf', 'check', topicIntent.id, '--allow-host', 'bcf-peer.test', '--token-env', 'BCF_TOKEN'])).code).toBe(0);
  expect((await entries())[0].check?.candidates).toEqual([{ guid: topicGuid }]);
  expect((await run(['bcf', 'reconcile', topicIntent.id, '--guid', topicGuid])).code).toBe(0);
  expect((await entries())[0].receipt?.remoteGuid).toBe(topicGuid);
  expect(peer.state.receivedWrites).toBe(1);
}, 60_000);

it('recovers comments across fresh CLI processes without duplicate sends (#7374)', async () => {
  const { peer, run, write, entries } = await setup();
  expect((await write('bcf.createTopic', { title: 'Comment recovery parent' })).code).toBe(0);
  const topicGuid = [...peer.state.topics.keys()][0];
  expect(topicGuid).toBeDefined();
  peer.state.loseNextWriteResponse = true;
  expect((await write('bcf.addComment', { topicGuid, comment: 'Restarted CLI comment' })).code).toBe(1);
  const commentGuid = peer.state.topics.get(topicGuid)!.comments[0].guid;
  expect((await write('bcf.addComment', { topicGuid, comment: 'Restarted CLI comment' })).code).toBe(1);
  expect(peer.state.receivedWrites).toBe(2);
  const commentIntent = (await entries()).find(entry => entry.state === 'uncertain')!;
  expect((await run(['bcf', 'check', commentIntent.id, '--allow-host', 'bcf-peer.test', '--token-env', 'BCF_TOKEN'])).code).toBe(0);
  expect((await run(['bcf', 'reconcile', commentIntent.id, '--guid', commentGuid])).code).toBe(0);
  expect((await entries()).find(entry => entry.id === commentIntent.id)?.receipt?.remoteGuid).toBe(commentGuid);
  expect((await write('bcf.addComment', { topicGuid, comment: 'Reviewed next comment' })).code).toBe(0);
  expect(peer.state.receivedWrites).toBe(3);
  expect(peer.state.topics.get(topicGuid)!.comments).toHaveLength(2);
}, 60_000);

it('refuses a secret-bearing payload before effect or durable leakage (#7374)', async () => {
  const { peer, outbox, write } = await setup();
  const result = await write('bcf.createTopic', { title: 'Secret {{secret:BCF_TOKEN}} in title' });
  expect(result.code).toBe(1);
  expect(result.stdout + result.stderr).not.toContain(LOCAL_BCF_TOKEN);
  expect(peer.state.receivedWrites).toBe(0);
  expect(await generatedJournalBytes(outbox)).not.toContain(LOCAL_BCF_TOKEN);
}, 20_000);

it('requires checked absence and explicit release before a deliberate next send (#7374)', async () => {
  const { peer, run, write, entries } = await setup();
  peer.state.loseNextWriteResponse = true;
  expect((await write('bcf.createTopic', { title: 'Reviewed absent CLI topic' })).code).toBe(1);
  expect(peer.state.acceptedWrites).toBe(1);
  const [intent] = await entries();
  expect((await run(['bcf', 'confirm-absent', intent.id])).code).toBe(1);
  expect(peer.state.receivedWrites).toBe(1);
  // The independent peer removes the committed object, modeling a coordinator deletion.
  peer.state.topics.clear();
  expect((await run(['bcf', 'check', intent.id, '--allow-host', 'bcf-peer.test', '--token-env', 'BCF_TOKEN'])).code).toBe(0);
  expect((await entries())[0].check?.result).toBe('unavailable');
  expect((await run(['bcf', 'confirm-absent', intent.id])).code).toBe(1);
  expect((await run(['bcf', 'check', intent.id, '--allow-host', 'bcf-peer.test', '--token-env', 'BCF_TOKEN', '--confirm-full-read-access'])).code).toBe(0);
  const confirmed = (await entries())[0].check;
  expect(confirmed?.result).toBe('absent');
  expect(confirmed?.fullReadAccessConfirmed).toBe(true);
  expect((await write('bcf.createTopic', { title: 'Reviewed absent CLI topic' })).code).toBe(1);
  expect(peer.state.receivedWrites).toBe(1);
  expect((await run(['bcf', 'confirm-absent', intent.id])).code).toBe(0);
  expect(peer.state.receivedWrites).toBe(1);
  expect((await write('bcf.createTopic', { title: 'Reviewed absent CLI topic' })).code).toBe(0);
  expect(peer.state.receivedWrites).toBe(2);
  expect(peer.state.topics.size).toBe(1);
}, 60_000);

it.each(['list', 'reconcile', 'confirm-absent'] as const)(
  'the full-read assertion is check-only, refused by actual CLI %s (#7374)', async action => {
    const { peer, run, write, entries } = await setup();
    expect((await write('bcf.createTopic', { title: 'Check-only assertion' })).code).toBe(0);
    expect(peer.state.acceptedWrites).toBe(1);
    const [entry] = await entries();
    const args = action === 'list' ? [] : [entry.id];
    if (action === 'reconcile') args.push('--guid', entry.receipt!.remoteGuid);
    const rejected = await run(['bcf', action, ...args, '--confirm-full-read-access']);
    expect(peer.state.receivedWrites).toBe(1);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('Usage:');
  }, 20_000);


it('accepts construction bearer prose but refuses credential-shaped authorization before real effect (#7374)', async () => {
  const { peer, write } = await setup();
  expect((await write('bcf.createTopic', { title: 'Floor bearer support', description: 'Bearer joists need coordination' })).code).toBe(0);
  expect(peer.state.acceptedWrites).toBe(1);
  expect([...peer.state.topics.values()][0].topic.title).toBe('Floor bearer support');
  expect((await write('bcf.createTopic', { title: 'Authorization: Bearer opaque987token' })).code).toBe(1);
  expect(peer.state.receivedWrites).toBe(1);
}, 30000);
