/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { startLocalBcfServer, LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN } from '../../../../apps/viewer/src/test/bcf-http-server.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// #7372 / review4254309182: a supported read mode is a prerequisite of the
// entire registered graph, before even an independently retained HTTP effect.
it('#7372 CLI rejects native Review before an earlier registered BCF publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ifc-review-preflight-'));
  const peer = await startLocalBcfServer();
  const executable = new URL('../../dist/index.js', import.meta.url).pathname;
  const preload = new URL('../test/bcf-publication-preload.mjs', import.meta.url).pathname;
  const model = new URL('../../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url).pathname;
  const outbox = join(directory, 'outbox');
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', preload, executable, 'flow', ...args], {
      env: { ...process.env, IFCLITE_BCF_OUTBOX_DIR: outbox, IFCLITE_TEST_BCF_PEER: peer.baseUrl, BCF_TOKEN: LOCAL_BCF_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Actual CLI preflight child exceeded 15 seconds')); }, 15_000);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); done({ code, stdout, stderr }); });
  });
  try {
    const graph = join(directory, 'unsupported.flow.json');
    await writeFile(graph, JSON.stringify({ flowVersion: 1, id: 'review-preflight', name: 'Unsupported native Review',
      capabilities: ['model.read', 'network.fetch:bcf-peer.test', 'secret.read:BCF_TOKEN'], inputs: [], outputs: [],
      nodes: [{ id: 'write', type: 'bcf.createTopic', params: { baseUrl: 'https://bcf-peer.test/bcf',
        projectId: LOCAL_BCF_PROJECT, token: '{{secret:BCF_TOKEN}}', title: 'Before unsupported native Review' } },
      { id: 'read', type: 'review.snapshot', params: {} }],
      edges: [{ from: ['write', 'guids'], to: ['read', 'after'] }],
    }));
    const result = await run(['run', graph, model, '--no-tracking', '--json']);
    const listing = await run(['bcf', 'list']);
    expect(listing.code, listing.stderr).toBe(0);
    const entries: unknown = JSON.parse(listing.stdout);
    expect(Array.isArray(entries)).toBe(true);
    if (peer.state.acceptedWrites) {
      // Baseline/inverse prerequisites: real effect and receipt, not a loader,
      // capability, token or network setup failure masquerading as the defect.
      expect(peer.state.receivedWrites).toBe(1);
      expect(peer.state.acceptedWrites).toBe(1);
      const original = [...peer.state.topics.values()][0].topic;
      expect(original.title).toBe('Before unsupported native Review');
      expect(entries).toEqual([expect.objectContaining({ state: 'done', receipt: expect.objectContaining({ remoteGuid: original.guid }) })]);
    }
    const diagnostic = result.stderr + result.stdout;
    expect(diagnostic).toMatch(/native session captures are unavailable|backend feature .review\.native./);
    const retained = [...peer.state.topics.values()][0]?.topic;
    const witness = { received: peer.state.receivedWrites, accepted: peer.state.acceptedWrites,
      retainedExpectedTitle: retained?.title === 'Before unsupported native Review',
      receiptMatchesOriginal: Array.isArray(entries) && entries.some(entry => record(entry) && entry.state === 'done'
        && record(entry.receipt) && entry.receipt.remoteGuid === retained?.guid) };
    expect(peer.state.receivedWrites, `unsupported Review must reject before effects; actual witness ${JSON.stringify(witness)}`).toBe(0);
    expect(result.code).toBe(1);
    expect(peer.state.acceptedWrites).toBe(0);
    expect(entries).toEqual([]);
    // Actual declared JSON Player input enables the supported historical mode;
    // it must not be falsely refused because the graph's stored params omit it.
    const historical = JSON.parse(await readFile(graph, 'utf8'));
    historical.inputs = [{ nodeId: 'read', param: 'savedValidationReports', kind: 'scalar', label: 'Saved history' }];
    historical.outputs = [{ nodeId: 'read', port: 'snapshot', label: 'Historical Review' }];
    await writeFile(graph, JSON.stringify(historical));
    const allowed = await run(['run', graph, model, '--no-tracking', '--json', '--input', 'read.savedValidationReports=[]']);
    expect(peer.state.receivedWrites).toBe(1);
    expect(peer.state.acceptedWrites).toBe(1);
    expect([...peer.state.topics.values()][0].topic.title).toBe('Before unsupported native Review');
    expect(allowed.code, allowed.stderr).toBe(0);
    const actual: unknown = JSON.parse(allowed.stdout);
    if (!record(actual)) throw new Error('Actual CLI historical result required');
    expect(actual.ok).toBe(true);
    expect(actual.nodes).toEqual({ ok: 2 });
  } finally { await peer.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
