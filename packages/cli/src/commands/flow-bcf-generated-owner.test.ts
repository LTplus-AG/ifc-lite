/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { startLocalBcfServer, LOCAL_BCF_PROJECT } from '../../../../apps/viewer/src/test/bcf-http-server.js';

const here = dirname(fileURLToPath(import.meta.url));
it.skipIf(process.platform !== 'linux')('#7374 actual CLI fails closed before HTTP for a generated owner hash colliding with a short bearer', async () => {
  const token = 'beef';
  const machine = '000000000000000000000000000000be';
  expect(createHash('sha256').update(machine).digest('hex')).toContain(token);
  const directory = await mkdtemp(join(tmpdir(), 'ifc-cli-owner-collision-'));
  const peer = await startLocalBcfServer({ token, guidPrefix: token });
  try {
    const graph = join(directory, 'owner.flow.json'), outbox = join(directory, 'outbox');
    await writeFile(graph, JSON.stringify({ flowVersion: 1, id: 'owner-collision', name: 'Owner collision',
      capabilities: ['network.fetch:bcf-peer.test'], inputs: [], outputs: [], edges: [],
      nodes: [{ id: 'write', type: 'bcf.createTopic', params: { baseUrl: 'https://bcf-peer.test/bcf',
        projectId: LOCAL_BCF_PROJECT, title: 'Clean topic', token } }] }));
    const child = spawn(process.execPath, ['--import', resolve(here, '../test/bcf-generated-owner-preload.mjs'),
      '--import', resolve(here, '../test/bcf-publication-preload.mjs'), resolve(here, '../../dist/index.js'),
      'flow', 'run', graph, resolve(here, '../../../../apps/viewer/public/samples/hello-wall.ifc'), '--no-tracking', '--json'],
    { env: { ...process.env, IFCLITE_TEST_BCF_PEER: peer.baseUrl, IFCLITE_BCF_OUTBOX_DIR: outbox }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const result = await new Promise<number | null>((done, reject) => {
      const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Owned CLI collision child exceeded 15 second deadline')); }, 15_000);
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('close', code => { clearTimeout(deadline); done(code); });
    });
    expect(peer.state.receivedWriteAttempts).toBe(0);
    expect(peer.state.receivedWrites).toBe(0);
    expect(peer.state.acceptedWrites).toBe(0);
    expect(result, stderr).toBe(1);
    expect(stdout + stderr).toContain('credentials must not enter durable state');
    expect(stdout + stderr).not.toContain(token);
    // Preparing the namespace/capacity is allowed; no intent may be persisted.
    const files = await readdir(outbox, { recursive: true });
    expect(files.some(file => file.endsWith('.intent.json'))).toBe(false);
    const listed = spawnSync(process.execPath, [resolve(here, '../../dist/index.js'), 'flow', 'bcf', 'list', '--json'],
      { env: { ...process.env, IFCLITE_BCF_OUTBOX_DIR: outbox }, encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000 });
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([]);
    expect(listed.stdout + listed.stderr).not.toContain(token);
  } finally { await peer.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
