/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7374: actual MCP run_flow in fresh processes; peer effects outlive hosts. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLocalBcfServer, LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN } from '../../../../apps/viewer/src/test/bcf-http-server.js';
import { buildDefaultToolRegistry } from './index.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER, type ToolContext } from '../context.js';
import { fullScope, readOnlyScope } from '../auth/scope.js';
import { BCF_PUBLICATION_PROBE_PATH } from '../test/bcf-publication-worker-path.js';

type Entry = { id: string; state: string; intent: unknown; receipt?: { remoteGuid: string }; check?: { candidates: { guid: string }[] } };
type Probe = { result?: { structuredContent?: { ok?: boolean; entries?: Entry[]; nextCursor?: string; entry?: Entry; outputs?: { key: string; data: unknown }[] } }; error?: { code?: string; message: string } };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function probe(directory: string, baseUrl: string, tool: string, input: Record<string, unknown>, principal?: string, remoteUnidentified = false, disconnectBeforeWrite = false, token = LOCAL_BCF_TOKEN): Promise<Probe> {
  return new Promise((resolveResult, reject) => {
    const config = { baseUrl, tool, input, principal, remoteUnidentified, disconnectBeforeWrite, model: resolve('../../apps/viewer/public/samples/building-architecture.ifc') };
    const child = spawn(process.execPath, ['--import', 'tsx', BCF_PUBLICATION_PROBE_PATH, JSON.stringify(config)],
      { env: { ...process.env, IFCLITE_BCF_OUTBOX_DIR: directory, BCF_TEST_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native BCF probe exceeded 20 seconds')); }, 20_000);
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(`BCF native probe failed (${code}): ${errors}`)); return; }
      try { resolveResult(JSON.parse(output.trim().split('\n').at(-1) ?? '') as Probe); }
      catch (error) { reject(new Error(`Invalid probe result: ${output}`, { cause: error })); }
    });
  });
}
function flow(params: Record<string, unknown>, capabilities = ['network.fetch:bcf-peer.test', 'secret.read:BCF_TEST_TOKEN']) {
  return { flowVersion: 2, id: 'native-bcf', name: 'Native BCF recovery', capabilities, inputs: [],
    outputs: [{ nodeId: 'write', port: 'guids', label: 'Created' }], edges: [],
    nodes: [{ id: 'write', type: 'bcf.createTopic', params: { baseUrl: 'https://bcf-peer.test/bcf',
      projectId: LOCAL_BCF_PROJECT, token: '{{secret:BCF_TEST_TOKEN}}', title: 'Durable native recovery', ...params } }] };
}
async function fixture(options: Parameters<typeof startLocalBcfServer>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ifc-mcp-bcf-'));
  const peer = await startLocalBcfServer(options);
  cleanup.push(peer.close, () => rm(directory, { recursive: true, force: true }));
  return { directory, peer };
}

async function journalBytes(path: string): Promise<string> {
  const parts: string[] = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    parts.push(item.isDirectory() ? await journalBytes(join(path, item.name)) : await readFile(join(path, item.name), 'utf8'));
  }
  return parts.join('\n');
}

it.each([['topic', 'literal', 'long'], ['topic', 'literal', 'short'], ['topic', 'Player', 'long'], ['topic', 'Player', 'short'],
  ['comment', 'literal', 'long'], ['comment', 'literal', 'short'], ['comment', 'Player', 'long'], ['comment', 'Player', 'short']] as const)(
  '#7374 actual %s success DTO redacts %s %s bearer echoes and retains its receipt', async (operation, source, length) => {
    const token = length === 'short' ? 'xy!' : 'echo-"\\-bearer-token';
    const { directory, peer } = await fixture({ token, echoWriteToken: true });
    let parentGuid: string | undefined;
    let before = 0;
    if (operation === 'comment') {
      const seeded = await fetch(`${peer.baseUrl}/2.1/projects/${LOCAL_BCF_PROJECT}/topics`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Independent comment parent' }),
      });
      expect(seeded.status).toBe(201);
      const value: unknown = await seeded.json();
      if (!value || typeof value !== 'object' || typeof Reflect.get(value, 'guid') !== 'string') {
        throw new Error('Actual peer did not return parent topic identity');
      }
      parentGuid = Reflect.get(value, 'guid');
      before = peer.state.acceptedWrites;
      expect(before).toBe(1);
    }
    const type = operation === 'topic' ? 'bcf.createTopic' : 'bcf.addComment';
    const payload = operation === 'topic' ? { title: 'Reviewed success echo control' }
      : { topicGuid: parentGuid, comment: 'Reviewed success comment' };
    const graph = { flowVersion: 2, id: 'native-bcf-success-echo', name: 'Native success redaction',
      capabilities: ['network.fetch:bcf-peer.test'],
      inputs: source === 'Player' ? [{ nodeId: 'write', param: 'token', label: 'Token', kind: 'scalar' }] : [],
      outputs: [{ nodeId: 'write', port: operation === 'topic' ? 'topics' : 'created', label: 'Created DTO' }],
      edges: [], nodes: [{ id: 'write', type, params: { baseUrl: 'https://bcf-peer.test/bcf',
        projectId: LOCAL_BCF_PROJECT, token: source === 'literal' ? token : '', ...payload } }] };
    const result = await probe(directory, peer.baseUrl, 'run_flow', { flow: graph,
      ...(source === 'Player' ? { inputs: { 'write.token': token } } : {}) });
    expect(peer.state.acceptedWrites).toBe(before + 1);
    expect(peer.state.receivedWrites).toBe(before + 1);
    expect(result.result?.structuredContent?.ok).toBe(true);
    const retained = [...peer.state.topics.values()].at(-1);
    if (!retained) throw new Error('Actual accepted peer effect missing');
    const original = operation === 'topic' ? retained.topic : retained.comments.at(-1);
    if (!original) throw new Error('Actual accepted comment missing');
    expect(operation === 'topic' ? retained.topic.title : retained.comments.at(-1)?.comment)
      .toBe(operation === 'topic' ? 'Reviewed success echo control' : 'Reviewed success comment');
    const output = result.result?.structuredContent?.outputs?.[0]?.data;
    // #7374: the actual topic port is a list; addComment.created is one DTO.
    if (operation === 'topic') {
      expect(Array.isArray(output)).toBe(true);
      expect(output).toHaveLength(1);
    } else {
      expect(Array.isArray(output)).toBe(false);
    }
    const dto: unknown = operation === 'topic' && Array.isArray(output) ? output[0] : output;
    if (!dto || typeof dto !== 'object') throw new Error('Actual BCF DTO output missing');
    expect(Reflect.get(dto, 'guid')).toBe(original.guid);
    expect(Reflect.get(dto, operation === 'topic' ? 'description' : 'comment')).toBe('Server echoed [REDACTED]');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(token).slice(1, -1));
    const listing = await probe(directory, peer.baseUrl, 'bcf_publications_list', {});
    expect(listing.result?.structuredContent?.entries).toHaveLength(1);
    expect(listing.result?.structuredContent?.entries?.[0]).toMatchObject({ state: 'done', receipt: { remoteGuid: original.guid } });
    expect(peer.state.acceptedWrites).toBe(before + 1);
    const stored = await journalBytes(directory);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(JSON.stringify(token).slice(1, -1));
  }, 60_000);

it('authorizes a short token_env through actual recovery GETs without exposing or rewriting the receipt (#7374)', async () => {
  const token = 'xy!';
  const { directory, peer } = await fixture({ token });
  peer.state.loseNextWriteResponse = true;
  const graph = flow({ token });
  const failed = await probe(directory, peer.baseUrl, 'run_flow', { flow: graph });
  expect(peer.state.receivedWrites).toBe(1);
  expect(peer.state.acceptedWrites).toBe(1);
  expect(failed.result?.structuredContent?.ok).toBe(false);
  const entry = (await probe(directory, peer.baseUrl, 'bcf_publications_list', {})).result?.structuredContent?.entries?.[0];
  if (!entry) throw new Error('Actual short-token lost-response intent missing');
  const input = { entry_id: entry.id, capabilities: ['network.fetch:bcf-peer.test'], token_env: 'BCF_TEST_TOKEN' };
  const denied = await probe(directory, peer.baseUrl, 'bcf_publication_check', input, undefined, false, false, token);
  expect(denied.error?.code).toBe('PERMISSION_DENIED');
  const checked = await probe(directory, peer.baseUrl, 'bcf_publication_check', {
    ...input, capabilities: [...input.capabilities, 'secret.read:BCF_TEST_TOKEN'],
  }, undefined, false, false, token);
  const original = [...peer.state.topics.values()][0].topic.guid;
  expect(checked.result?.structuredContent?.entry?.check?.candidates).toEqual([{ guid: original }]);
  expect(JSON.stringify(checked)).not.toContain(token);
  const reconciled = await probe(directory, peer.baseUrl, 'bcf_publication_reconcile', { entry_id: entry.id, candidate_guid: original });
  expect(reconciled.result?.structuredContent?.entry?.receipt?.remoteGuid).toBe(original);
  const stored = await journalBytes(directory);
  expect(stored).not.toContain(token);
  expect(peer.state.receivedWrites).toBe(1);
  expect(peer.state.acceptedWrites).toBe(1);
}, 60_000);

it('requires persisted explicit unknown-owner confirmation after a real MCP sender is killed (#7374)', async () => {
  const { directory, peer } = await fixture();
  const config = { baseUrl: peer.baseUrl, tool: 'run_flow', input: { flow: flow({}) }, holdAfterWrite: true,
    model: resolve('../../apps/viewer/public/samples/building-architecture.ifc') };
  const child = spawn(process.execPath, ['--import', 'tsx', BCF_PUBLICATION_PROBE_PATH, JSON.stringify(config)],
    { env: { ...process.env, IFCLITE_BCF_OUTBOX_DIR: directory, BCF_TEST_TOKEN: LOCAL_BCF_TOKEN }, stdio: 'ignore' });
  const ended = new Promise<void>((resolveEnded, reject) => { child.once('error', reject); child.once('close', () => resolveEnded()); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const deadline = Date.now() + 15_000;
    while (peer.state.acceptedWrites === 0 && Date.now() < deadline) await new Promise(resolvePoll => setTimeout(resolvePoll, 20));
    expect(peer.state.receivedWrites).toBe(1);
    expect(peer.state.acceptedWrites).toBe(1);
  } finally { child.kill('SIGKILL'); await ended; clearTimeout(timer); }
  async function intents(path: string): Promise<string[]> {
    const found: string[] = [];
    for (const item of await readdir(path, { withFileTypes: true })) {
      const name = join(path, item.name);
      if (item.isDirectory()) found.push(...await intents(name));
      else if (item.name.endsWith('.intent.json')) found.push(name);
    }
    return found;
  }
  const paths = await intents(directory);
  expect(paths).toHaveLength(1);
  const stored: unknown = JSON.parse(await readFile(paths[0], 'utf8'));
  if (!stored || typeof stored !== 'object') throw new Error('Killed actual sender intent missing');
  const owner: unknown = Reflect.get(stored, 'owner');
  if (!owner || typeof owner !== 'object') throw new Error('Actual sender identity missing');
  // Preserve the actual immutable intent/digest and start identity; simulate foreign machine identity.
  Reflect.set(owner, 'host', 'f'.repeat(64));
  await writeFile(paths[0], JSON.stringify(stored));
  const listing = await probe(directory, peer.baseUrl, 'bcf_publications_list', {});
  const entry = listing.result?.structuredContent?.entries?.[0];
  expect(entry).toMatchObject({ state: 'uncertain', ownerStatus: 'unknown' });
  if (!entry) throw new Error('Killed sender not listed');
  expect((await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({}) })).result?.structuredContent?.ok).toBe(false);
  expect(peer.state.receivedWrites).toBe(1);
  const checkInput = { entry_id: entry.id, capabilities: ['network.fetch:bcf-peer.test', 'secret.read:BCF_TEST_TOKEN'], token_env: 'BCF_TEST_TOKEN' };
  const refused = await probe(directory, peer.baseUrl, 'bcf_publication_check', checkInput);
  expect(refused.error?.message).toMatch(/owner is unknown/);
  const checked = await probe(directory, peer.baseUrl, 'bcf_publication_check', { ...checkInput, confirm_owner_stopped: true });
  const original = [...peer.state.topics.values()][0].topic.guid;
  expect(checked.result?.structuredContent?.entry?.check?.candidates).toEqual([{ guid: original }]);
  const reconciled = await probe(directory, peer.baseUrl, 'bcf_publication_reconcile', { entry_id: entry.id, candidate_guid: original });
  expect(reconciled.result?.structuredContent?.entry).toMatchObject({ state: 'done', receipt: { remoteGuid: original } });
  expect(peer.state.receivedWrites).toBe(1);
  expect(peer.state.acceptedWrites).toBe(1);
}, 60_000);

it('pages independently retained native effects across fresh MCP processes without losing receipts (#7374)', async () => {
  const { directory, peer } = await fixture();
  for (const title of ['Page first', 'Page second', 'Page third']) {
    const result = await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({ title }) });
    expect(peer.state.acceptedWrites).toBe(peer.state.receivedWrites);
    expect(result.result?.structuredContent?.ok).toBe(true);
  }
  expect(peer.state.acceptedWrites).toBe(3);
  const retained = [...peer.state.topics.values()].map(value => value.topic.guid).sort();
  const receipts: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const listing = await probe(directory, peer.baseUrl, 'bcf_publications_list', { limit: 1, ...(cursor ? { cursor } : {}) });
    const content = listing.result?.structuredContent;
    expect(content?.entries?.length).toBeLessThanOrEqual(1);
    for (const entry of content?.entries ?? []) {
      expect(entry.state).toBe('done');
      if (!entry.receipt) throw new Error('Actual durable peer receipt missing');
      receipts.push(entry.receipt.remoteGuid);
    }
    cursor = content?.nextCursor;
    pages += 1;
    if (pages > 257) throw new Error('Native bounded pages did not terminate');
  } while (cursor);
  expect(receipts.sort()).toEqual(retained);
  expect(peer.state.receivedWrites).toBe(3);
}, 60_000);

it('#7374 refuses commit-then-lost-response duplicate across process restart, checks actual candidate, reconciles and retains receipt', async () => {
  const { directory, peer } = await fixture();
  peer.state.loseNextWriteResponse = true;
  const first = await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({}) });
  expect(first.result?.structuredContent?.ok).toBe(false);
  expect(peer.state.acceptedWrites).toBe(1);
  expect(peer.state.topics.size).toBe(1);
  const retry = await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({}) });
  // Check the independently retained peer effect before the host's error flag.
  expect(peer.state.receivedWrites).toBe(1);
  expect(retry.result?.structuredContent?.ok).toBe(false);
  const listing = await probe(directory, peer.baseUrl, 'bcf_publications_list', {});
  const entry = listing.result?.structuredContent?.entries?.[0];
  expect(entry).toBeDefined(); if (!entry) throw new Error('Durable intent missing');
  const denied = await probe(directory, peer.baseUrl, 'bcf_publication_check', { entry_id: entry.id,
    capabilities: ['secret.read:BCF_TEST_TOKEN'], token_env: 'BCF_TEST_TOKEN' });
  expect(denied.error).toBeDefined(); expect(peer.state.receivedWrites).toBe(1);
  const unauthorized = await probe(directory, peer.baseUrl, 'bcf_publication_check', { entry_id: entry.id,
    capabilities: ['network.fetch:bcf-peer.test'], token_env: 'BCF_TEST_TOKEN' });
  expect(unauthorized.error?.code).toBe('PERMISSION_DENIED');
  const checked = await probe(directory, peer.baseUrl, 'bcf_publication_check', { entry_id: entry.id,
    capabilities: ['network.fetch:bcf-peer.test', 'secret.read:BCF_TEST_TOKEN'], token_env: 'BCF_TEST_TOKEN' });
  const remoteGuid = [...peer.state.topics.keys()][0];
  expect(checked.result?.structuredContent?.entry?.check?.candidates).toEqual([{ guid: remoteGuid }]);
  const arbitrary = await probe(directory, peer.baseUrl, 'bcf_publication_reconcile', { entry_id: entry.id, candidate_guid: 'invented-guid' });
  expect(arbitrary.error).toBeDefined();
  const reconciled = await probe(directory, peer.baseUrl, 'bcf_publication_reconcile', { entry_id: entry.id, candidate_guid: remoteGuid });
  expect(reconciled.result?.structuredContent?.entry?.receipt?.remoteGuid).toBe(remoteGuid);
  const after = await probe(directory, peer.baseUrl, 'bcf_publications_list', {});
  expect(after.result?.structuredContent?.entries?.[0]?.receipt?.remoteGuid).toBe(remoteGuid);
  expect(peer.state.receivedWrites).toBe(1);
  const next = await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({ title: 'Separately reviewed next issue' }) });
  expect(next.result?.structuredContent?.ok).toBe(true); expect(peer.state.acceptedWrites).toBe(2);
  const stored = await journalBytes(directory);
  expect(stored).not.toContain(LOCAL_BCF_TOKEN);
}, 60_000);

it('#7374 literal bearer tokens and resolved Player token overrides cannot enter a durable payload', async () => {
  const { directory, peer } = await fixture();
  const literal = await probe(directory, peer.baseUrl, 'run_flow', {
    flow: flow({ token: LOCAL_BCF_TOKEN, title: LOCAL_BCF_TOKEN }, ['network.fetch:bcf-peer.test']),
  });
  expect(literal.result?.structuredContent?.ok).toBe(false); expect(JSON.stringify(literal)).not.toContain(LOCAL_BCF_TOKEN);
  expect(peer.state.receivedWrites).toBe(0);
  const graph = { ...flow({ token: '', title: 'A reviewed title' }, ['network.fetch:bcf-peer.test']),
    inputs: [{ nodeId: 'write', param: 'token', label: 'Token', kind: 'scalar' },
      { nodeId: 'write', param: 'title', label: 'Title', kind: 'scalar' }] };
  const overridden = await probe(directory, peer.baseUrl, 'run_flow', {
    flow: graph, inputs: { 'write.token': LOCAL_BCF_TOKEN, 'write.title': LOCAL_BCF_TOKEN },
  });
  expect(overridden.result?.structuredContent?.ok).toBe(false); expect(JSON.stringify(overridden)).not.toContain(LOCAL_BCF_TOKEN);
  expect(peer.state.receivedWrites).toBe(0);
  expect((await probe(directory, peer.baseUrl, 'bcf_publications_list', {})).result?.structuredContent?.entries).toEqual([]);
}, 30_000);

it('#7374 a real HTTP error echoing the bearer token preserves uncertainty without returning the credential', async () => {
  const { directory, peer } = await fixture();
  peer.state.loseNextWriteResponse = true;
  await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({}) });
  const entry = (await probe(directory, peer.baseUrl, 'bcf_publications_list', {})).result?.structuredContent?.entries?.[0];
  expect(entry).toBeDefined(); if (!entry) throw new Error('Retained uncertainty missing');
  const methods: string[] = [];
  const hostile = createServer((request, response) => {
    methods.push(request.method ?? '');
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: `Invalid bearer ${LOCAL_BCF_TOKEN}` }));
  });
  await new Promise<void>((resolveReady, reject) => {
    hostile.once('error', reject); hostile.listen(0, '127.0.0.1', () => { hostile.removeListener('error', reject); resolveReady(); });
  });
  cleanup.push(() => new Promise<void>((resolveClosed, reject) => {
    hostile.close(error => { if (error) reject(error); else resolveClosed(); }); hostile.closeAllConnections();
  }));
  const address = hostile.address();
  if (!address || typeof address === 'string') throw new Error('Malicious test peer missing address');
  const checked = await probe(directory, `http://127.0.0.1:${address.port}/bcf`, 'bcf_publication_check', {
    entry_id: entry.id, capabilities: ['network.fetch:bcf-peer.test', 'secret.read:BCF_TEST_TOKEN'], token_env: 'BCF_TEST_TOKEN',
  });
  expect(methods).toEqual(['GET']); expect(checked.error).toBeDefined(); expect(JSON.stringify(checked)).not.toContain(LOCAL_BCF_TOKEN);
  const retained = await probe(directory, peer.baseUrl, 'bcf_publications_list', {});
  expect(retained.result?.structuredContent?.entries?.[0]).toMatchObject({ state: 'uncertain', check: { result: 'unavailable' } });
  expect(JSON.stringify(retained)).not.toContain(LOCAL_BCF_TOKEN); expect(peer.state.receivedWrites).toBe(1);
}, 30_000);

it('#7374 isolates stable principals across sessions and rejects secret-bearing payload before sending', async () => {
  const { directory, peer } = await fixture();
  peer.state.loseNextWriteResponse = true;
  await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({}) }, 'alice@example.test');
  expect((await probe(directory, peer.baseUrl, 'bcf_publications_list', {}, 'bob@example.test')).result?.structuredContent?.entries).toEqual([]);
  expect((await probe(directory, peer.baseUrl, 'bcf_publications_list', {}, 'alice@example.test')).result?.structuredContent?.entries).toHaveLength(1);
  await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({}) }, 'alice@example.test');
  expect(peer.state.receivedWrites).toBe(1);
  const leaked = await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({ title: '{{secret:BCF_TEST_TOKEN}}' }) }, 'bob@example.test');
  expect(leaked.result?.structuredContent?.ok).toBe(false);
  expect(JSON.stringify(leaked)).not.toContain(LOCAL_BCF_TOKEN);
  expect(peer.state.receivedWrites).toBe(1);
}, 60_000);

it('#7374 recovery tools retain scope/readOnly boundaries even through direct handlers', async () => {
  const tools = buildDefaultToolRegistry();
  const ctx: ToolContext = { registry: new InMemoryModelRegistry(), scope: readOnlyScope(), progress: NOOP_PROGRESS,
    log: SILENT_LOGGER, signal: new AbortController().signal, config: DEFAULT_CONFIG };
  for (const name of ['bcf_publication_check', 'bcf_publication_reconcile', 'bcf_publication_confirm_absent']) {
    const tool = tools.get(name); expect(tool?.scope).toBe('mutate');
    await expect(tool?.handler({}, ctx)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(tool?.handler({}, { ...ctx, scope: fullScope(), config: { ...DEFAULT_CONFIG, readOnly: true } })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  }
});

it('#7374 remote sessions without a stable principal cannot publish or read journals, while ordinary flows run', async () => {
  const { directory, peer } = await fixture();
  const write = await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({}) }, undefined, true);
  expect(write.error?.code).toBe('PERMISSION_DENIED'); expect(peer.state.receivedWrites).toBe(0);
  const list = await probe(directory, peer.baseUrl, 'bcf_publications_list', {}, undefined, true);
  expect(list.error?.code).toBe('PERMISSION_DENIED');
  const read = { flowVersion: 2, id: 'read', name: 'Read model', capabilities: ['model.read'], inputs: [],
    outputs: [{ nodeId: 'walls', port: 'entities', label: 'Walls' }], edges: [],
    nodes: [{ id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } }] };
  const ordinary = await probe(directory, peer.baseUrl, 'run_flow', { flow: read }, undefined, true);
  expect(ordinary.result?.structuredContent?.ok).toBe(true); expect(peer.state.receivedWrites).toBe(0);
}, 30_000);

it('#7374 complete checked absence needs explicit full access-scope confirmation before a separately reviewed identical send', async () => {
  const { directory, peer } = await fixture({ anonymousReadVisibility: 'full', allowAnonymousWrites: true });
  const failed = await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({}) }, undefined, false, true);
  expect(failed.result?.structuredContent?.ok).toBe(false); expect(peer.state.receivedWrites).toBe(0);
  const listing = await probe(directory, peer.baseUrl, 'bcf_publications_list', {});
  const entry = listing.result?.structuredContent?.entries?.[0];
  expect(entry).toBeDefined(); if (!entry) throw new Error('Unknown-outcome intent missing');
  expect((await probe(directory, peer.baseUrl, 'bcf_publication_confirm_absent', { entry_id: entry.id })).error).toBeDefined();
  const unconfirmedInput = { entry_id: entry.id, capabilities: ['network.fetch:bcf-peer.test'] };
  const unconfirmed = await probe(directory, peer.baseUrl, 'bcf_publication_check', unconfirmedInput);
  expect(unconfirmed.result?.structuredContent?.entry?.check).toMatchObject({ result: 'unavailable', candidates: [] });
  expect((await probe(directory, peer.baseUrl, 'bcf_publication_confirm_absent', { entry_id: entry.id })).error).toBeDefined();
  const falseConfirmation = await probe(directory, peer.baseUrl, 'bcf_publication_check', { ...unconfirmedInput, confirm_full_read_access: false });
  expect(falseConfirmation.result?.structuredContent?.entry?.check).toMatchObject({ result: 'unavailable' });
  const invalidConfirmation = await probe(directory, peer.baseUrl, 'bcf_publication_check', { ...unconfirmedInput, confirm_full_read_access: 'true' });
  expect(invalidConfirmation.error).toBeDefined();
  const checkInput = { ...unconfirmedInput, confirm_full_read_access: true };
  const checked = await probe(directory, peer.baseUrl, 'bcf_publication_check', checkInput);
  expect(checked.result?.structuredContent?.entry?.check).toMatchObject({ result: 'absent', candidates: [], fullReadAccessConfirmed: true });
  const blocked = await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({}) });
  expect(blocked.result?.structuredContent?.ok).toBe(false); expect(peer.state.receivedWrites).toBe(0);
  // A newer denied check supersedes earlier evidence; it cannot release the intent.
  await probe(directory, peer.baseUrl, 'bcf_publication_check', { ...checkInput, capabilities: [] });
  expect((await probe(directory, peer.baseUrl, 'bcf_publication_confirm_absent', { entry_id: entry.id })).error).toBeDefined();
  await probe(directory, peer.baseUrl, 'bcf_publication_check', checkInput);
  const confirmed = await probe(directory, peer.baseUrl, 'bcf_publication_confirm_absent', { entry_id: entry.id });
  expect(confirmed.result?.structuredContent?.entry?.state).toBe('failed'); expect(peer.state.receivedWrites).toBe(0);
  const later = await probe(directory, peer.baseUrl, 'run_flow', { flow: flow({}) });
  expect(later.result?.structuredContent?.ok).toBe(true); expect(peer.state.receivedWrites).toBe(1); expect(peer.state.acceptedWrites).toBe(1);
}, 60_000);


it.each(['topic', 'comment'] as const)(
  '#7374 real MCP filtered anonymous read cannot release a retained authenticated %s without full-scope confirmation', async operation => {
    const { directory, peer } = await fixture({ anonymousReadVisibility: 'filtered' });
    let parentGuid: string | undefined;
    let before = 0;
    if (operation === 'comment') {
      const seeded = await fetch(`${peer.baseUrl}/2.1/projects/${LOCAL_BCF_PROJECT}/topics`, {
        method: 'POST', headers: { authorization: `Bearer ${LOCAL_BCF_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Independent visibility parent' }),
      });
      expect(seeded.status).toBe(201);
      const value: unknown = await seeded.json();
      if (!value || typeof value !== 'object' || typeof Reflect.get(value, 'guid') !== 'string') {
        throw new Error('Actual visibility parent identity absent');
      }
      parentGuid = Reflect.get(value, 'guid');
      before = peer.state.acceptedWrites;
      expect(before).toBe(1);
    }
    const graph = { flowVersion: 2, id: 'native-mcp-visibility', name: 'Native MCP visibility',
      capabilities: ['network.fetch:bcf-peer.test', 'secret.read:BCF_TEST_TOKEN'], inputs: [], edges: [],
      outputs: [{ nodeId: 'write', port: operation === 'topic' ? 'guids' : 'guid', label: 'Created' }],
      nodes: [{ id: 'write', type: operation === 'topic' ? 'bcf.createTopic' : 'bcf.addComment',
        params: { baseUrl: 'https://bcf-peer.test/bcf', projectId: LOCAL_BCF_PROJECT,
          token: '{{secret:BCF_TEST_TOKEN}}', ...(operation === 'topic'
            ? { title: 'Retained visibility topic' } : { topicGuid: parentGuid, comment: 'Retained visibility comment' }) } }] };
    peer.state.loseNextWriteResponse = true;
    const sent = await probe(directory, peer.baseUrl, 'run_flow', { flow: graph });
    expect(sent.result?.structuredContent?.ok).toBe(false);
    expect(peer.state.acceptedWrites).toBe(before + 1);
    expect(peer.state.receivedWrites).toBe(before + 1);
    const retained = operation === 'topic' ? [...peer.state.topics.values()].at(-1)?.topic
      : [...peer.state.topics.values()].find(value => value.topic.guid === parentGuid)?.comments.at(-1);
    if (!retained) throw new Error('Actual independently retained BCF effect missing');
    const listed = await probe(directory, peer.baseUrl, 'bcf_publications_list', {});
    const entry = listed.result?.structuredContent?.entries?.[0];
    if (!entry) throw new Error('Actual unresolved durable MCP intent missing');
    expect(entry.state).toBe('uncertain');
    const input = { entry_id: entry.id, capabilities: ['network.fetch:bcf-peer.test'] };
    const hidden = await probe(directory, peer.baseUrl, 'bcf_publication_check', input);
    expect(hidden.result?.structuredContent?.entry?.check).toMatchObject({ result: 'unavailable', candidates: [] });
    expect((await probe(directory, peer.baseUrl, 'bcf_publication_confirm_absent', { entry_id: entry.id })).error).toBeDefined();
    const retried = await probe(directory, peer.baseUrl, 'run_flow', { flow: graph });
    expect(retried.result?.structuredContent?.ok).toBe(false);
    expect(peer.state.acceptedWrites).toBe(before + 1);
    expect(peer.state.receivedWrites).toBe(before + 1);
    const visible = await probe(directory, peer.baseUrl, 'bcf_publication_check', { ...input,
      capabilities: ['network.fetch:bcf-peer.test', 'secret.read:BCF_TEST_TOKEN'], token_env: 'BCF_TEST_TOKEN' });
    expect(visible.result?.structuredContent?.entry?.check).toMatchObject({ result: 'ambiguous', candidates: [{ guid: retained.guid }] });
    expect(peer.state.acceptedWrites).toBe(before + 1);
    expect(peer.state.receivedWrites).toBe(before + 1);
  }, 90_000);
