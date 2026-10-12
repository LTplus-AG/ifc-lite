/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7374: actual CLI processes redact response DTOs while an independent HTTP peer retains effects.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function setup(options: { token?: string; echoWriteToken?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ifc-cli-bcf-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const peer = await startLocalBcfServer(options);
  cleanup.push(peer.close);
  const graph = join(directory, 'write.flow.json');
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', preload, executable, 'flow', ...args], {
      env: { ...process.env, IFCLITE_TEST_BCF_PEER: peer.baseUrl, BCF_TOKEN: options.token ?? LOCAL_BCF_TOKEN },
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
  return { peer, directory, graph, document, run, write };
}

it.each([['bcf.createTopic', 'literal'], ['bcf.createTopic', 'Player'],
  ['bcf.addComment', 'literal'], ['bcf.addComment', 'Player']] as const)(
  'redacts actual successful %s response bearer echo from %s credentials (#7374)', async (type, source) => {
    const token = source === 'Player' ? 'xy!' : 'quote"slash\\credential';
    const { peer, graph, document, run, write } = await setup({ token, echoWriteToken: true });
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
    expect(guid).toBeTruthy();
  }, 60_000);
