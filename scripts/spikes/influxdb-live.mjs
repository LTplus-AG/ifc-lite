/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8090 disposable live witness. Build examples/headless-workflows first.
 * Run via ~/build-workers/ifc-fleet; owns only its named Docker container,
 * loopback HTTPS test gateway and temporary certificate directory.
 * No user credentials, persistent database volume or insecure TLS override.
 */
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const directory = await mkdtemp(join(tmpdir(), 'ifclite-influx-8090-'));
const name = `ifclite-influx-8090-${randomBytes(6).toString('hex')}`;
const output = resolve(process.argv[2] ?? '/tmp/ifclite-influx-live.html');
const model = resolve('apps/viewer/public/samples/building-architecture.ifc');
const image = 'influxdb:2.7.12';
let owned = false;
let gateway;
const timeout = AbortSignal.timeout(180000);
async function json(url, body, token) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Token ${token}` } : {}) },
    body: JSON.stringify(body), signal: timeout,
  });
  assert.ok(response.ok, `Provisioning failed: HTTP ${response.status}`);
  return response.json();
}
try {
  await execFile('docker', ['run', '-d', '--rm', '--name', name, '--label', 'ifclite.spike=8090',
    '--cpus=1', '--memory=512m', '-p', '127.0.0.1::8086', image], { timeout: 180000 });
  owned = true;
  const { stdout: port } = await execFile('docker', ['port', name, '8086/tcp']);
  const upstream = `http://${port.trim()}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = (await fetch(`${upstream}/health`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch (error) { if (attempt === 59) throw error; }
    if (ready) break;
    await new Promise(done => setTimeout(done, 500));
  }
  assert.ok(ready, 'InfluxDB never became healthy');
  const setup = await json(`${upstream}/api/v2/setup`, {
    username: 'spike', password: randomBytes(24).toString('hex'), org: 'spike', bucket: 'monitoring',
  });
  const access = await json(`${upstream}/api/v2/authorizations`, {
    orgID: setup.org.id,
    permissions: [{ action: 'read', resource: { type: 'buckets', id: setup.bucket.id, orgID: setup.org.id } }],
  }, setup.auth.token);
  const targets = [
    ['0xY$LvXaDEswJDk_VU74C_', 'room-a', 21.8, 120],
    ['0xY$LvXaDEswJDk_VU74C_', 'room-a', 22.2, 60],
    ['0xY$LvXaDEswJDk_VU74C_', 'room-a', 22.5, 0],
    ['18QhMtUIXBvQktPHXXxs7H', 'hall-a', 20, 0],
    ['18QhMtUIXBvQktPHXXxs7H', 'hall-b', 21, 0],
    ['missing-in-model', 'unknown', 19, 0],
  ];
  const now = Date.now() - 1000;
  const points = targets.map(([guid, device, value, age]) =>
    `environment,ifc_guid=${guid},device=${device} temperature=${value} ${(now - Number(age) * 1000)}`).join('\n');
  const writeUrl = `${upstream}/api/v2/write?org=spike&bucket=monitoring&precision=ms`;
  const seeded = await fetch(writeUrl, { method: 'POST', headers: { Authorization: `Token ${setup.auth.token}` }, body: points, signal: timeout });
  assert.equal(seeded.status, 204);
  const refused = await fetch(writeUrl, { method: 'POST', headers: { Authorization: `Token ${access.token}` }, body: points, signal: timeout });
  assert.equal(refused.status, 403, 'Query token must not be able to write');

  const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
  await execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-days', '1']);
  gateway = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
    try {
      const path = new URL(request.url, 'https://localhost');
      if (request.method !== 'POST' || path.pathname !== '/api/v2/query') { response.writeHead(404).end(); return; }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) throw new Error('Request cap'); chunks.push(chunk); }
      const result = await fetch(`${upstream}${path.pathname}${path.search}`, {
        method: 'POST', headers: { Authorization: request.headers.authorization ?? '', 'Content-Type': 'application/json', Accept: 'application/csv' },
        body: Buffer.concat(chunks), signal: timeout,
      });
      response.writeHead(result.status, { 'Content-Type': 'application/csv' });
      response.end(await result.text());
    } catch (error) {
      response.writeHead(502).end('Live witness gateway failed');
      console.error(error instanceof Error ? error.name : 'Gateway error');
    }
  });
  await new Promise(done => gateway.listen(0, '127.0.0.1', done));
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  const config = join(directory, 'selection.json');
  await writeFile(config, JSON.stringify({
    url: `https://localhost:${address.port}`, org: 'spike', bucket: 'monitoring', measurement: 'environment',
    field: 'temperature', guidTag: 'ifc_guid', unit: '°C',
  }));
  const { stdout } = await execFile(process.execPath, [
    'examples/headless-workflows/dist/influx.mjs', model, config, output,
  ], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, INFLUX_TOKEN: access.token }, timeout: 60000 });
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.source, 'live-influxdb-2');
  assert.equal(receipt.matched, 1);
  assert.equal(receipt.unmatched, 1);
  assert.equal(receipt.ambiguous, 2);
  assert.equal(receipt.samples, 6);
  const html = await readFile(output, 'utf8');
  assert.equal(html.includes(access.token), false);
  assert.equal(html.includes(setup.auth.token), false);
  const data = JSON.parse(html.split('<script type="application/json" id="data">')[1].split('</script>')[0]);
  assert.equal(data.matched.rows[0]._value, 22.5);
  assert.equal(data.entityNames[data.matched.rows[0].GlobalId], 'living room');
  console.log(JSON.stringify({ ...receipt, image, readTokenWriteStatus: refused.status, tlsVerified: true }));
} finally {
  if (gateway) await new Promise(done => gateway.close(done));
  if (owned) await execFile('docker', ['rm', '-f', name]);
  await rm(directory, { recursive: true, force: true });
}
