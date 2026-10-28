/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createServer, preview, build } from 'vite';
import { retainedEngine } from '../../../vite-plugins/retained-engine';

const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'viewer-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'engine');
  // Inert inventory, not a geometry engine. validateEngine remains real.
  const paths = ['pkg-retained/ifc-lite.js', 'pkg-retained/ifc-lite_bg.wasm', 'pkg-retained/package.json',
    'smlib/node/client.mjs', 'smlib/node/worker.mjs', 'smlib/node/hooks.mjs', 'smlib/worker.mjs', 'smlib/module.mjs',
    'smlib/sweep.mjs', 'smlib/sweep-contract.mjs', 'smlib/contract.mjs', 'smlib/client.mjs',
    'smlib/ifclite_smlib_browser.mjs', 'smlib/ifclite_smlib_browser.wasm', 'LICENSES/SMLib/LICENSE',
    'LICENSES/SMLib/THIRD_PARTY_NOTICES.md', 'LICENSES/ifc-lite/LICENSE', 'smlib/x'];
  const assets = [];
  for (const path of paths) {
    const content = `inert ${path}`;
    await mkdir(join(directory, path, '..'), { recursive: true });
    await writeFile(join(directory, path), content);
    assets.push({ path, bytes: Buffer.byteLength(content), sha256: digest(content) });
  }
  const manifest = JSON.stringify({ format: 'ifc-lite.retained-engine/1', sdk: { revision: '0'.repeat(40) }, capabilities: {}, assets });
  await writeFile(join(directory, 'engine-manifest.json'), manifest);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.html'), 'exact viewer fixture');
  return { root, directory, etag: `"${digest(manifest)}"` };
}
function get(port: number, path: string, headers = {}) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}

for (const mode of ['dev', 'preview'] as const) {
  test(`#7955 ${mode} serves validated engine and notices with MIME/ETag; rejects traversal`, async (t) => {
    const f = await fixture(t);
    const config = { root: f.root, configFile: false as const, logLevel: 'silent' as const,
      plugins: [retainedEngine({ enabled: true, directory: f.directory })],
      server: { host: '127.0.0.1', port: 0 }, preview: { host: '127.0.0.1', port: 0 } };
    const server = mode === 'dev' ? await createServer(config) : await preview(config);
    t.after(() => server.close());
    if ('listen' in server) await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== 'string');
    for (const [path, mime] of [
      ['/smlib/x', 'text/plain'], ['/smlib/client.mjs', 'text/javascript'],
      ['/smlib/ifclite_smlib_browser.wasm', 'application/wasm'],
      ['/retained-engine/LICENSES/SMLib/LICENSE', 'text/plain'],
      ['/retained-engine/LICENSES/SMLib/THIRD_PARTY_NOTICES.md', 'text/plain'],
      ['/retained-engine/engine-manifest.json', 'application/json'],
      ['/retained-engine/pkg-retained/ifc-lite.js', 'text/javascript'],
    ]) {
      const result = await get(address.port, path);
      assert.equal(result.status, 200, path);
      assert(result.headers['content-type']?.startsWith(mime));
      assert.equal(result.headers.etag, f.etag);
      assert.equal(result.headers['cache-control'], 'no-cache');
      assert.equal(result.headers['cross-origin-embedder-policy'], 'credentialless', `${path}: a Worker without COEP is blocked under isolation`);
      assert.equal(result.headers['cross-origin-opener-policy'], 'same-origin');
      const cached = await get(address.port, path, { 'If-None-Match': f.etag });
      assert.equal(cached.status, 304);
      assert.equal(cached.body, '');
    }
    for (const path of ['/smlib/../engine-manifest.json', '/smlib/%2e%2e/engine-manifest.json',
      '/retained-engine/%2e%2e/secret', '/smlib/..%5csecret']) {
      assert.equal((await get(address.port, path)).status, 403, path);
    }
    assert.equal((await get(address.port, '/smlib/%xx')).status, 400);
    assert.equal((await get(address.port, '/retained-engine/smlib/x')).status, 404);
    assert.equal((await get(address.port, '/smlib/missing')).status, 404);
  });

  test(`#7955 ${mode} refuses missing and corrupt engines with validator errors`, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.directory, 'smlib/x'), 'tampered');
    for (const directory of [undefined, f.directory]) {
      const config = { root: f.root, configFile: false as const, logLevel: 'silent' as const,
        plugins: [retainedEngine({ enabled: true, directory })] };
      await assert.rejects(mode === 'dev' ? createServer(config) : preview(config),
        directory ? /manifest hash mismatch/ : /IFCLITE_RETAINED_ENGINE/);
    }
  });
}

test('#7955 a refused dev start exits instead of leaving Vite servers running', async (t) => {
  const f = await fixture(t);
  // In a child process: a leaked watcher/server would keep THIS runner alive.
  const plugin = new URL('../../../vite-plugins/retained-engine.ts', import.meta.url).href;
  const script = join(f.root, 'refused-dev.mjs');
  const vite = import.meta.resolve('vite');
  await writeFile(script, `import { createServer } from ${JSON.stringify(vite)};
import { retainedEngine } from ${JSON.stringify(plugin)};
await createServer({ root: ${JSON.stringify(f.root)}, configFile: false, logLevel: 'silent',
  plugins: [retainedEngine({ enabled: true })] }).then(() => process.exit(2), (error) =>
  { if (!/IFCLITE_RETAINED_ENGINE/.test(String(error))) process.exit(3); });`);
  const result = spawnSync(process.execPath, [...process.execArgv, script],
    { cwd: process.cwd(), timeout: 30_000, encoding: 'utf8' });
  assert.equal(result.signal, null, 'refused dev start never exited: Vite servers were left running');
  assert.equal(result.status, 0, result.stderr);
});

test('#7955 retained is off by default and forbidden under VERCEL=1', () => {
  assert.equal(retainedEngine({ enabled: false, vercel: '1' }), false);
  assert.throws(() => retainedEngine({ enabled: true, vercel: '1' }), /forbidden in Vercel/);
});

test('#7955 build bundles only the host; the shared loader emits no engine assets', async (t) => {
  const f = await fixture(t);
  const loader = new URL('../../../../../packages/wasm/retained.js', import.meta.url).pathname;
  await writeFile(join(f.root, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(join(f.root, 'main.js'), "globalThis.host = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });");
  await writeFile(join(f.root, 'worker.js'), `import { loadRetainedEngine } from ${JSON.stringify(loader)}; self.onmessage = () => loadRetainedEngine({ moduleUrl: '/retained-engine/pkg-retained/ifc-lite.js' });`);
  const result = await build({ root: f.root, configFile: false, logLevel: 'silent',
    plugins: [retainedEngine({ enabled: true })],
    worker: { format: 'es', plugins: () => [retainedEngine({ enabled: true })] },
    build: { minify: false } });
  assert(!Array.isArray(result) && 'output' in result);
  const worker = result.output.find(o => /worker-.*\.js/.test(o.fileName));
  assert(worker, 'module Worker was emitted');
  assert(!result.output.some(o => /ifc-lite|smlib|\.wasm/.test(o.fileName)), 'no engine payload was emitted');
});
