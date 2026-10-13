/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7374: default journal identity must survive CLI restarts from another cwd.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { parseCapabilities } from '@ifc-lite/extensions';
import { createNativeBcfWriteGateway } from '@ifc-lite/flow-nodes/bcf-publication-node';
import { LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN, startLocalBcfServer } from '../../../../apps/viewer/src/test/bcf-http-server.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const preload = createRequire(import.meta.url).resolve('tsx');
const program = fileURLToPath(new URL('../test/bcf-native-process.mjs', import.meta.url));
const model = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));

async function run(cwd: string, config: Record<string, unknown>, tsxConfig: string, outbox: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: tsxConfig };
  if (outbox === undefined) delete env.IFCLITE_BCF_OUTBOX_DIR;
  else env.IFCLITE_BCF_OUTBOX_DIR = outbox;
  return new Promise<{ ok: boolean; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, program, JSON.stringify(config)],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20_000);
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (timedOut) { reject(new Error('Cross-cwd CLI probe exceeded 20 seconds')); return; }
      if (code !== 0) { reject(new Error(`Cross-cwd CLI failed (${code}): ${errors}`)); return; }
      try {
        const value: unknown = JSON.parse(output.trim().split('\n').at(-1) ?? '');
        if (!value || typeof value !== 'object') throw new Error('Expected actual CLI Flow result');
        const ok: unknown = Reflect.get(value, 'ok');
        if (typeof ok !== 'boolean') throw new Error('Expected actual CLI Flow verdict');
        resolve({ ok, output });
      } catch (error) { reject(error); }
    });
  });
}

it.each(['empty', 'unset', 'explicit'] as const)(
  '%s outbox selection preserves a lost-response CLI intent across two real working directories (#7374)', async mode => {
    const temporary = await mkdtemp(join(tmpdir(), 'bcf-root-cwd-'));
    cleanup.push(() => rm(temporary, { recursive: true, force: true }));
    const peer = await startLocalBcfServer();
    cleanup.push(peer.close);
    const firstCwd = join(temporary, 'first'), secondCwd = join(temporary, 'second');
    const explicit = join(temporary, 'explicit'), configured = join(temporary, 'configured');
    for (const directory of [firstCwd, secondCwd, explicit, configured]) await mkdir(directory);
    const namespace = `root-selection-${randomUUID()}`;
    const root = mode === 'explicit' ? explicit : join(homedir(), '.ifc-lite', 'bcf-outbox');
    // Only our random namespace is touched or removed; HOME and user journals are never changed.
    const ownedNamespace = join(root, createHash('sha256').update(namespace).digest('hex'));
    cleanup.push(() => rm(ownedNamespace, { recursive: true, force: true }));
    const tsxConfig = join(temporary, 'tsx.json');
    await writeFile(tsxConfig, JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', paths: {} } }));
    const config = { ...(mode === 'explicit' ? { directory: explicit } : {}), namespace,
      baseUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT, token: LOCAL_BCF_TOKEN,
      operation: 'topic', mode: 'exact', title: 'Stable journal root', model };
    const envRoot = mode === 'empty' ? '' : mode === 'explicit' ? configured : undefined;
    peer.state.loseNextWriteResponse = true;
    const first = await run(firstCwd, config, tsxConfig, envRoot);
    expect(peer.state.receivedWriteAttempts).toBe(1);
    expect(peer.state.acceptedWrites).toBe(1);
    const retained = [...peer.state.topics.values()][0].topic;
    expect(retained.title).toBe(config.title);
    const originalGuid = retained.guid;
    expect(first.ok).toBe(false);
    // The original empty-env behavior accepts a second actual POST from this different cwd.
    const second = await run(secondCwd, config, tsxConfig, envRoot);
    expect(peer.state.receivedWriteAttempts).toBe(1);
    expect(peer.state.acceptedWrites).toBe(1);
    expect([...peer.state.topics.keys()]).toEqual([originalGuid]);
    expect(second.ok).toBe(false);
    const fresh = createNativeBcfWriteGateway({ directory: root, namespace });
    const entries = await fresh.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.state).toBe('uncertain');
    expect(entry.receipt).toBeUndefined();
    expect(await readdir(firstCwd)).toEqual([]);
    expect(await readdir(secondCwd)).toEqual([]);
    expect(await readdir(configured)).toEqual([]);
    const grants = parseCapabilities(['network.fetch:bcf.example.test']);
    if (!grants.ok) throw new Error('Invalid controlled BCF grant');
    const checked = await fresh.check(entry.id, { token: LOCAL_BCF_TOKEN, networkGrants: grants.value,
      networkTransport: (url, init) => {
        if (url.origin !== 'https://bcf.example.test') throw new Error('Unexpected controlled BCF target');
        return fetch(peer.baseUrl + url.pathname.replace(/^\/bcf/, '') + url.search, init);
      } });
    expect(checked.check?.candidates).toEqual([{ guid: originalGuid }]);
    await fresh.reconcile(entry.id, originalGuid);
    expect((await createNativeBcfWriteGateway({ directory: root, namespace }).list())[0].receipt?.remoteGuid).toBe(originalGuid);
    expect(peer.state.receivedWriteAttempts).toBe(1);
  }, 60_000);
