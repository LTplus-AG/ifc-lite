/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8947: capture evidence must come from the owned preview and requested build.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function reservePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const chosen = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return chosen; // Vite strictPort and owned startup below also guard the bind race.
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export async function startOwnedPreview({ root, dist, signal, port = 0, command, timeoutMs = 90000 }) {
  signal?.throwIfAborted();
  const expectedHash = hash(await readFile(join(dist, 'index.html')));
  const chosen = await reservePort(port);
  signal?.throwIfAborted();
  const url = `http://127.0.0.1:${chosen}`;
  const cwd = join(root, 'apps/viewer');
  const argv = command ? command(chosen) : [process.execPath,
    join(dirname(createRequire(join(cwd, 'package.json')).resolve('vite/package.json')), 'bin/vite.js'),
    'preview', '--outDir', dist, '--port', String(chosen), '--strictPort', '--host', '127.0.0.1'];
  const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; let failure; let ready = false; let closing;
  child.once('error', error => { failure = error; });
  child.once('exit', (code, exitSignal) => { failure ??= new Error(`Owned preview exited: ${code ?? exitSignal}`); });
  child.stdout.on('data', bytes => {
    log = (log + bytes).slice(-16000);
    // The CLI prints its URL only AFTER its own strict-port listen succeeds.
    ready ||= stripVTControlCharacters(log).includes(`Local:   ${url}/`);
  });
  child.stderr.on('data', bytes => { log = (log + bytes).slice(-16000); });
  const close = () => closing ??= (async () => {
    signal?.removeEventListener('abort', abort);
    if (!child.pid) return;
    signalGroup(child.pid, 'SIGTERM');
    const deadline = Date.now() + 3000;
    while (signalGroup(child.pid, 0) && Date.now() < deadline) await delay(25);
    if (signalGroup(child.pid, 0)) {
      signalGroup(child.pid, 'SIGKILL');
      const killDeadline = Date.now() + 2000;
      while (signalGroup(child.pid, 0) && Date.now() < killDeadline) await delay(25);
      if (signalGroup(child.pid, 0)) throw new Error(`Owned preview group ${child.pid} survived cleanup`);
    }
  })();
  const abort = () => { close().catch(error => console.error(`Preview abort cleanup: ${error}`)); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const deadline = Date.now() + timeoutMs;
    while (!ready) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      if (Date.now() >= deadline) throw new Error('Owned preview did not report successful startup');
      await delay(25);
    }
    signal?.throwIfAborted();
    if (failure) throw failure;
    const response = await fetch(`${url}/index.html`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      redirect: 'error', cache: 'no-store',
    });
    const servedHash = hash(Buffer.from(await response.arrayBuffer()));
    if (failure) throw failure;
    if (!response.ok || servedHash !== expectedHash) throw new Error('Owned preview served a different index than the requested build');
    return { url, close, assertAlive() {
      signal?.throwIfAborted();
      if (failure) throw failure;
    }, identity: { pid: child.pid, url, expectedIndexSha256: expectedHash, servedIndexSha256: servedHash } };
  } catch (error) {
    await close();
    throw new Error(`${error.message}\n${log}`, { cause: error });
  }
}
