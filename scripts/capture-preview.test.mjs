/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startOwnedPreview } from '../tests/ui-scenes/capture-preview.mjs';

const moduleUrl = new URL('../tests/ui-scenes/capture-preview.mjs', import.meta.url).href;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'capture-preview-test-'));
  const disposers = [];
  t.after(async () => {
    const failures = [];
    for (const dispose of disposers.reverse()) {
      try { await dispose(); } catch (error) { failures.push(error); }
    }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Preview test cleanup');
  });
  const dist = join(root, 'dist');
  await mkdir(join(root, 'apps/viewer'), { recursive: true });
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<h1>requested build</h1>');
  const server = join(root, 'server.mjs');
  await writeFile(server, `import { createServer } from 'node:http';
const port = Number(process.argv[2]);
const server = createServer((req, res) => res.end(process.argv[3]));
server.listen(port, '127.0.0.1', () => console.log('  ➜  Local:   http://127.0.0.1:' + port + '/'));
`);
  return { root, dist, defer: dispose => disposers.push(dispose), command: port => [process.execPath, server, String(port), '<h1>requested build</h1>'] };
}
async function sentinel(setup) {
  const server = createServer((req, res) => res.end('foreign build'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  setup.defer(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function refused(url) {
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }), /fetch failed/);
}

test('#8947 owned preview verifies served bytes and releases its listening socket', { timeout: 10000 }, async t => {
  const setup = await fixture(t);
  const preview = await startOwnedPreview(setup);
  setup.defer(() => preview.close());
  assert.equal(await (await fetch(preview.url)).text(), '<h1>requested build</h1>');
  assert.equal(preview.identity.servedIndexSha256, preview.identity.expectedIndexSha256);
  preview.assertAlive();
  await preview.close();
  await refused(preview.url);
});

test('#8947 occupied preview port cannot certify or terminate a foreign build', { timeout: 10000 }, async t => {
  const setup = await fixture(t);
  const foreign = await sentinel(setup);
  await assert.rejects(startOwnedPreview({ ...setup, port: Number(new URL(foreign).port) }), /EADDRINUSE/);
  assert.equal(await (await fetch(foreign)).text(), 'foreign build');
});

test('#8947 successful owned startup still rejects different served bytes', { timeout: 10000 }, async t => {
  const setup = await fixture(t);
  await assert.rejects(startOwnedPreview({ ...setup, command(port) {
    const argv = setup.command(port);
    argv[3] = 'wrong build';
    return argv;
  } }), /different index/);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`#8947 ${signal} awaits owned preview cleanup while a foreign server survives`, { timeout: 12000 }, async t => {
    const setup = await fixture(t);
    const foreign = await sentinel(setup);
    const driver = join(setup.root, 'driver.mjs');
    await writeFile(driver, `import { startOwnedPreview } from ${JSON.stringify(moduleUrl)};
const controller = new AbortController();
let finish;
const interrupted = new Promise(resolve => { finish = resolve; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { controller.abort(new Error(signal)); finish(); });
const preview = await startOwnedPreview({ root: ${JSON.stringify(setup.root)}, dist: ${JSON.stringify(setup.dist)},
  signal: controller.signal, command: port => [process.execPath, ${JSON.stringify(join(setup.root, 'server.mjs'))}, String(port), '<h1>requested build</h1>'] });
console.log(JSON.stringify(preview.identity));
await interrupted;
await preview.close();
process.exitCode = 1;
`);
    const child = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    setup.defer(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } });
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const deadline = Date.now() + 5000;
    while (!output.includes('\n') && child.exitCode === null && Date.now() < deadline) await delay(20);
    assert.ok(output.includes('\n'), errors || 'preview never became ready');
    const identity = JSON.parse(output.trim());
    assert.equal(await (await fetch(identity.url)).text(), '<h1>requested build</h1>');
    child.kill(signal);
    const [code] = await exited;
    assert.equal(code, 1, errors);
    await refused(identity.url);
    assert.throws(() => process.kill(-identity.pid, 0), { code: 'ESRCH' });
    assert.equal(await (await fetch(foreign)).text(), 'foreign build');
  });
}
