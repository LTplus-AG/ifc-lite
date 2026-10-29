/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8090 disposable Experimental MVP viewer witness. Run under ifc-fleet.
 * Uses the repository's Playwright witness workflow so browser and database
 * run on the same admitted host. Owns only uniquely named containers/services.
 * Prerequisites: built viewer dependencies + WASM runtime, Chromium, and
 * Docker or INFLUXD_BIN pointing to a verified InfluxDB OSS 2 binary.
 * No credentials are printed or written, and no browser trace is retained.
 */
import assert from 'node:assert/strict';
import { execFile as callback, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
const execFile = promisify(callback);
const directory = resolve(process.argv[2] ?? 'docs/architecture/evidence/influxdb-8090/viewer');
const name = `ifclite-influx-viewer-${randomBytes(6).toString('hex')}`;
const image = 'influxdb:2.7.12';
const modelPath = 'apps/viewer/public/samples/building-architecture.ifc';
const model = await readFile(modelPath);
assert.ok(model.includes(Buffer.from('0xY$LvXaDEswJDk_VU74C_')));

let owned = false, gateway, vite, browser, database, databaseDirectory;
let databaseIdentity;
async function json(url, body, token) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Token ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, `Provisioning failed: HTTP ${response.status}`);
  return response.json();
}
async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
try {
  let upstream;
  if (process.env.INFLUXD_BIN) {
    const binary = resolve(process.env.INFLUXD_BIN);
    const version = (await execFile(binary, ['version'])).stdout.trim();
    const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
    databaseIdentity = { mode: 'binary', version, sha256 };
    databaseDirectory = await mkdtemp(join(tmpdir(), 'ifclite-influx-witness-'));
    const bind = `127.0.0.1:${await freePort()}`;
    upstream = `http://${bind}`;
    database = spawn(binary, ['--http-bind-address', bind, '--bolt-path', join(databaseDirectory, 'influxd.bolt'),
      '--engine-path', join(databaseDirectory, 'engine'), '--sqlite-path', join(databaseDirectory, 'influxd.sqlite'),
      '--reporting-disabled'], { cwd: databaseDirectory, stdio: 'ignore' });
    await new Promise((done, reject) => { database.once('spawn', done); database.once('error', reject); });
  } else {
    await execFile('docker', ['run', '-d', '--rm', '--name', name, '--label', 'ifclite.witness=8090-viewer', '--cpus=1', '--memory=512m', '-p', '127.0.0.1::8086', image]);
    owned = true;
    const imageInfo = JSON.parse((await execFile('docker', ['image', 'inspect', image])).stdout)[0];
    databaseIdentity = { mode: 'docker', image, imageDigest: imageInfo.RepoDigests?.[0] };
    upstream = `http://${(await execFile('docker', ['port', name, '8086/tcp'])).stdout.trim()}`;
  }
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await fetch(`${upstream}/health`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch (error) { if (i === 59) throw new Error(`Database health: ${error.name}`); }
    if (ready) break;
    await new Promise(done => setTimeout(done, 500));
  }
  assert.ok(ready, 'Database did not become healthy');
  const setup = await json(`${upstream}/api/v2/setup`, { username: 'synthetic', password: randomBytes(24).toString('hex'), org: 'synthetic', bucket: 'monitoring' });
  const access = await json(`${upstream}/api/v2/authorizations`, { orgID: setup.org.id, permissions: [{ action: 'read', resource: { type: 'buckets', id: setup.bucket.id, orgID: setup.org.id } }] }, setup.auth.token);
  const now = Date.now() - 1000;
  const targets = [
    ['0xY$LvXaDEswJDk_VU74C_', 'synthetic-room', 21.8, 120],
    ['0xY$LvXaDEswJDk_VU74C_', 'synthetic-room', 22.2, 60],
    ['0xY$LvXaDEswJDk_VU74C_', 'synthetic-room', 22.5, 0],
    ['18QhMtUIXBvQktPHXXxs7H', 'synthetic-hall-a', 20, 0],
    ['18QhMtUIXBvQktPHXXxs7H', 'synthetic-hall-b', 21, 0],
    ['missing-in-model', 'synthetic-unknown', 19, 0],
  ];
  const points = targets.map(([guid, device, value, age]) => `environment,ifc_guid=${guid},device=${device} temperature=${value} ${now - age * 1000}`).join('\n');
  const writeUrl = `${upstream}/api/v2/write?org=synthetic&bucket=monitoring&precision=ms`;
  const seeded = await fetch(writeUrl, { method: 'POST', headers: { Authorization: `Token ${setup.auth.token}` }, body: points });
  assert.equal(seeded.status, 204);
  const denied = await fetch(writeUrl, { method: 'POST', headers: { Authorization: `Token ${access.token}` }, body: points });
  assert.equal(denied.status, 403);
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  let queryCount = 0, preflightCount = 0;
  gateway = createServer(async (request, response) => {
    if (request.headers.origin !== origin) { response.writeHead(403).end(); return; }
    const path = new URL(request.url, 'http://localhost');
    if (path.pathname !== '/api/v2/query') { response.writeHead(404).end(); return; }
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Private-Network': 'true' };
    if (request.method === 'OPTIONS') { preflightCount++; response.writeHead(204, cors).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405, cors).end(); return; }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) throw new Error('Request too large'); chunks.push(chunk); }
      queryCount++;
      const result = await fetch(`${upstream}/api/v2/query${path.search}`, { method: 'POST', headers: { Authorization: request.headers.authorization ?? '', 'Content-Type': 'application/json', Accept: 'application/csv' }, body: Buffer.concat(chunks), signal: AbortSignal.timeout(15000) });
      response.writeHead(result.status, { ...cors, 'Content-Type': 'application/csv' });
      response.end(await result.text());
    } catch { response.writeHead(502, cors).end('Synthetic witness gateway failed'); }
  });
  await new Promise(done => gateway.listen(0, '127.0.0.1', done));
  const gatewayUrl = `http://localhost:${gateway.address().port}`;
  vite = spawn('pnpm', ['--filter', '@ifc-lite/viewer', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  // Consume output without retaining a large dev log or exposing input values.
  vite.stdout.resume(); vite.stderr.resume();
  let viteReady = false;
  for (let i = 0; i < 120; i++) {
    try { viteReady = (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; }
    catch (error) { if (i === 119) throw new Error(`Viewer health: ${error.name}`); }
    if (viteReady) break;
    await new Promise(done => setTimeout(done, 500));
  }
  assert.ok(viteReady, 'Viewer dev server unavailable');
  browser = await chromium.launch({ ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}), args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-vulkan-surface', '--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let pageErrors = 0;
  page.on('pageerror', () => pageErrors++);
  await page.addInitScript(() => localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'witness'));
  await page.goto(`${origin}/?model=/samples/building-architecture.ifc`, { timeout: 120000 });
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.models.size === 1 && !state.loading && !state.geometryStreamingActive && [...state.models.values()].every(model => model.ifcDataStore);
  }, undefined, { timeout: 120000 });
  // Select a real parsed model entity through the canonical store action.
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const [model] = state.models.values();
    const expressId = model.ifcDataStore.entities.getExpressIdByGlobalId('0xY$LvXaDEswJDk_VU74C_');
    state.setSelectedEntityId(state.toGlobalId(model.id, expressId));
    state.openPanelInHome('influx');
  });
  const panel = page.getByRole('region', { name: 'InfluxDB 2', exact: true });
  for (const [label, value] of [['InfluxDB URL', gatewayUrl], ['Organization', 'synthetic'], ['Bucket', 'monitoring'], ['Measurement', 'environment'], ['Numeric field', 'temperature'], ['GUID tag key', 'ifc_guid'], ['Display unit', '°C'], ['Token (memory only)', access.token]]) {
    await panel.getByLabel(label, { exact: true }).fill(value);
  }
  await panel.getByRole('button', { name: 'Load', exact: true }).click();
  await panel.getByText('Latest: 22.5 °C', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await panel.getByRole('img').getAttribute('aria-label'), 'History for living room: 3 samples');
  assert.match(await panel.innerText(), /Ambiguous series \(2\)/);
  assert.match(await panel.innerText(), /Unmatched series \(1\)/);
  const persisted = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  assert.equal(persisted.includes(access.token), false);
  assert.ok(queryCount > 0 && preflightCount > 0);
  // Remove the password from the visible DOM after querying; it is not evidence.
  await panel.getByLabel('Token (memory only)').evaluate(input => { input.value = ''; });
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, 'desktop.png') });
  const evidence = { source: 'synthetic-live-influxdb-2-viewer', commit: (await execFile('git', ['rev-parse', 'HEAD'])).stdout.trim(), database: databaseIdentity, model: modelPath, modelSha256: createHash('sha256').update(model).digest('hex'), latest: 22.5, unit: '°C', historySamples: 3, unmatched: 1, ambiguous: 2, queryCount, preflightCount, tokenPersisted: false, readTokenWriteStatus: denied.status, pageErrors, viewport: { width: 1440, height: 1000 } };
  await writeFile(resolve(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(evidence));
} catch (error) {
  console.error(error);
  process.exitCode ||= 1;
} finally {
  const cleanup = async (label, step) => {
    try { await step(); }
    catch (error) {
      console.error(`Cleanup failed: ${label}: ${error?.code ?? error?.name ?? 'error'}`);
      process.exitCode ||= 1;
    }
  };
  if (browser) await cleanup('browser', () => browser.close());
  if (vite?.pid) await cleanup('vite', () => {
    try { process.kill(-vite.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  });
  if (gateway) await cleanup('gateway', () => new Promise((done, reject) => gateway.close(error => error ? reject(error) : done())));
  if (owned) await cleanup('docker', () => execFile('docker', ['rm', '-f', name]));
  if (database && database.exitCode === null && database.signalCode === null) await cleanup('influxd', async () => {
    const exited = new Promise(done => database.once('exit', done));
    database.kill('SIGTERM');
    const timer = setTimeout(() => database.kill('SIGKILL'), 10000);
    try { await exited; } finally { clearTimeout(timer); }
  });
  if (databaseDirectory) await cleanup('database storage', () => rm(databaseDirectory, { recursive: true, force: true }));
}
