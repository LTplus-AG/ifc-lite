/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7374: real direct Flow hosts must not label retained effects definite or leak server echoes.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { startLocalBcfServer, LOCAL_BCF_PROJECT } from '../../../../apps/viewer/src/test/bcf-http-server.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

it.each([[201, false], [303, false], [409, false], [500, false], [401, false],
  [201, true], [401, true], [500, true]] as const)('native HTTP%s gateway=%s preserves boundary semantics and redacts actual literal/Player bearer errors (#7374)', async (status, gateway) => {
  for (const player of [false, true]) {
    const token = player ? 'xy!' : 'echo-"\\-failure-token';
    const peer = await startLocalBcfServer({ token, echoWriteToken: true, ...(status === 401 || status === 201 ? {} : { afterWriteStatus: status }) });
    cleanup.push(peer.close);
    if (status === 401) peer.state.tokenValid = false;
    const directory = await mkdtemp(join(tmpdir(), 'bcf-direct-peer-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const tsconfig = join(directory, 'tsx.json');
    await writeFile(tsconfig, JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', paths: {} } }));
    const config = { directory, baseUrl: peer.baseUrl, projectId: LOCAL_BCF_PROJECT, token, player, gateway,
      operation: 'topic', title: 'Independent direct effect',
      model: fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)) };
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../test/bcf-direct-process.mjs', import.meta.url)), JSON.stringify(config)],
        { env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Direct native host exceeded20second deadline')); }, 20_000);
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('close', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }); });
    });
    // Independent acceptance comes before interpreting any host error.
    expect(peer.state.receivedWriteAttempts, result.stderr + result.stdout).toBe(1);
    expect(peer.state.receivedWrites).toBe(status === 401 ? 0 : 1);
    expect(peer.state.acceptedWrites).toBe(status === 401 ? 0 : 1);
    expect(peer.state.topics.size).toBe(status === 401 ? 0 : 1);
    if (status !== 401) expect([...peer.state.topics.values()][0].topic.title).toBe('Independent direct effect');
    expect(result.code, result.stderr).toBe(0);
    const returned = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as { ok: boolean; errors: string[] };
    expect(returned.ok).toBe(status === 201);
    if (status === 201) expect(result.stdout).toContain('Server echoed [REDACTED]');
    else if (gateway) expect(returned.errors.join(' ')).toContain('[REDACTED]');
    else expect(returned.errors.join(' ')).toContain(status === 401 ? 'request refused (auth, HTTP 401)' : 'outcome unknown');
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(result.stdout + result.stderr).not.toContain(JSON.stringify(token).slice(1, -1));
    expect(peer.state.receivedWriteAttempts).toBe(1); // No automatic retry after an ambiguous answer.
  }
}, 60_000);
