/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Loopback zot registry with htpasswd auth, for the `oci://` integration lane
 * (.github/workflows/oci-integration.yml).
 *
 *   node scripts/oci-integration/start-registry.mjs start --state-dir <dir> [--user <name>]
 *   node scripts/oci-integration/start-registry.mjs logs  --state-dir <dir>
 *   node scripts/oci-integration/start-registry.mjs stop  --state-dir <dir>
 *
 * `start` reads the password from OCI_REGISTRY_PASSWORD (never argv, so it
 * cannot leak through `ps` or a logged command line), writes a bcrypt
 * htpasswd entry with `htpasswd -niB` (password on stdin), writes a zot
 * config bound to 127.0.0.1 on a free port, starts `zot serve` detached, and
 * waits -- with a deadline -- until the registry both REFUSES an anonymous
 * `GET /v2/` (401) and ACCEPTS the configured credentials (200). A registry
 * that answers 200 anonymously would make the lane's wrong-password case
 * vacuous, so that is a startup failure, not a pass.
 *
 * On success it prints `registry=127.0.0.1:<port>` and, under GitHub Actions,
 * writes `address=127.0.0.1:<port>` to $GITHUB_OUTPUT. On any failure it dumps
 * zot's log, stops the process and exits non-zero.
 *
 * Requires `zot` and `htpasswd` on PATH (.github/actions/setup-oci-registries
 * provides both; locally, apache2-utils provides htpasswd). zot's htpasswd
 * backend is bcrypt-only, which is why this shells out rather than hashing in
 * Node: there is no bcrypt in the Node standard library.
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

const READY_DEADLINE_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const BIND_ATTEMPTS = 3;

function fail(message) {
  process.stderr.write(`start-registry: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command = 'start', ...rest] = argv;
  const options = { command, stateDir: undefined, user: 'ifclite-ci' };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === '--state-dir' && value) { options.stateDir = resolve(value); i += 1; }
    else if (flag === '--user' && value) { options.user = value; i += 1; }
    else fail(`unknown or incomplete argument: ${flag}`);
  }
  if (!['start', 'logs', 'stop'].includes(options.command)) fail(`unknown command: ${options.command}`);
  if (!options.stateDir) fail('--state-dir <dir> is required');
  if (!/^[A-Za-z0-9._-]+$/.test(options.user)) fail('--user must match [A-Za-z0-9._-]+');
  return options;
}

const paths = (stateDir) => ({
  config: join(stateDir, 'zot-config.json'),
  htpasswd: join(stateDir, 'htpasswd'),
  storage: join(stateDir, 'storage'),
  log: join(stateDir, 'zot.log'),
  stdio: join(stateDir, 'zot.stdio.log'),
  pid: join(stateDir, 'zot.pid'),
  address: join(stateDir, 'address'),
});

function dumpLogs(stateDir) {
  const p = paths(stateDir);
  for (const file of [p.stdio, p.log]) {
    process.stderr.write(`----- ${file} -----\n`);
    process.stderr.write(existsSync(file) ? readFileSync(file, 'utf8') : '(absent)\n');
  }
}

function stop(stateDir) {
  const p = paths(stateDir);
  if (!existsSync(p.pid)) {
    console.log('start-registry: no zot.pid, nothing to stop');
    return;
  }
  const pid = Number(readFileSync(p.pid, 'utf8').trim());
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`start-registry: sent SIGTERM to zot pid ${pid}`);
  } catch (error) {
    // ESRCH: already gone, which is the state stop() exists to reach.
    if (error.code !== 'ESRCH') throw error;
    console.log(`start-registry: zot pid ${pid} already exited`);
  }
  rmSync(p.pid, { force: true });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function writeHtpasswd(file, user, password) {
  const result = spawnSync('htpasswd', ['-niB', user], { input: `${password}\n`, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    fail('htpasswd not found on PATH (install apache2-utils, or run .github/actions/setup-oci-registries)');
  }
  if (result.status !== 0) fail(`htpasswd exited ${result.status}: ${result.stderr}`);
  const entry = result.stdout.trim();
  if (!entry.startsWith(`${user}:$2`)) fail('htpasswd did not produce a bcrypt entry');
  writeFileSync(file, `${entry}\n`, { mode: 0o600 });
}

async function probe(url, authorization) {
  try {
    const response = await fetch(url, {
      headers: authorization ? { authorization } : {},
      signal: AbortSignal.timeout(2_000),
    });
    await response.arrayBuffer();
    return response.status;
  } catch (error) {
    return `unreachable (${error.cause?.code ?? error.name})`;
  }
}

/** Resolves to null when ready, or to a reason string when it never got there. */
async function waitReady(child, port, authorization) {
  const url = `http://127.0.0.1:${port}/v2/`;
  let exited = null;
  child.once('exit', (code, signal) => { exited = signal ?? `code ${code}`; });
  const deadline = Date.now() + READY_DEADLINE_MS;
  let last = 'no response yet';
  while (Date.now() < deadline) {
    if (exited) return `zot exited (${exited}) before becoming ready`;
    const anonymous = await probe(url);
    if (anonymous === 401) {
      const authed = await probe(url, authorization);
      if (authed === 200) return null;
      last = `anonymous 401 but authenticated ${authed}`;
    } else if (anonymous === 200) {
      return 'registry accepted an anonymous request; auth is not enforced';
    } else {
      last = `anonymous ${anonymous}`;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return `not ready within ${READY_DEADLINE_MS} ms (last: ${last})`;
}

async function start({ stateDir, user }) {
  const password = process.env.OCI_REGISTRY_PASSWORD;
  if (!password) fail('OCI_REGISTRY_PASSWORD must be set (the registry password; never passed on argv)');
  const p = paths(stateDir);
  if (existsSync(p.pid)) fail(`${p.pid} exists; stop the previous registry first`);
  mkdirSync(p.storage, { recursive: true });
  writeHtpasswd(p.htpasswd, user, password);
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

  let reason = 'not attempted';
  for (let attempt = 1; attempt <= BIND_ATTEMPTS; attempt += 1) {
    // The probe socket is closed before zot binds, so another process can take
    // the port in between; zot then exits on bind and the next attempt picks a
    // new port.
    const port = await freePort();
    const config = {
      distSpecVersion: '1.1.1',
      storage: { rootDirectory: p.storage, dedupe: false, gc: false },
      http: { address: '127.0.0.1', port: String(port), auth: { htpasswd: { path: p.htpasswd } } },
      log: { level: 'info', output: p.log },
    };
    writeFileSync(p.config, `${JSON.stringify(config, null, 2)}\n`);
    const stdio = openSync(p.stdio, 'a');
    const child = spawn('zot', ['serve', p.config], { detached: true, stdio: ['ignore', stdio, stdio] });
    const spawnError = await new Promise((r) => {
      child.once('spawn', () => r(null));
      child.once('error', r);
    });
    if (spawnError) {
      fail(spawnError.code === 'ENOENT'
        ? 'zot not found on PATH (run .github/actions/setup-oci-registries)'
        : `could not start zot: ${spawnError.message}`);
    }
    writeFileSync(p.pid, `${child.pid}\n`);
    reason = await waitReady(child, port, authorization);
    if (reason === null) {
      child.unref();
      const address = `127.0.0.1:${port}`;
      writeFileSync(p.address, `${address}\n`);
      console.log(`registry=${address}`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `address=${address}\n`);
      return;
    }
    process.stderr.write(`start-registry: attempt ${attempt}/${BIND_ATTEMPTS} on port ${port}: ${reason}\n`);
    stop(stateDir);
    // Auth not enforced is a configuration defect; a new port will not fix it.
    if (reason.includes('auth is not enforced')) break;
  }
  dumpLogs(stateDir);
  fail(`zot did not become ready: ${reason}`);
}

const options = parseArgs(process.argv.slice(2));
if (options.command === 'logs') dumpLogs(options.stateDir);
else if (options.command === 'stop') stop(options.stateDir);
else await start(options);
