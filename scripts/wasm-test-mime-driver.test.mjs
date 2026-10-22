// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { startMimeDriverProxy, repairWorkerBootstrap } from './wasm-test-mime-driver.mjs';

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test('real HTTP module proxy fixes snippet and SDK MIME while preserving bytes and failures', async () => {
  const module = 'export const witness = "unaltered";\n';
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const host = await serve((request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (request.url === '/run.js') {
      assert.equal(request.headers['accept-encoding'], 'identity');
      assert.equal(request.headers['if-none-match'], undefined);
      response.writeHead(200, { 'content-type': 'text/javascript', etag: 'upstream' });
      response.end("shim + 'await import(' + JSON.stringify(scriptUrl) + ');'");
    }
    else if (request.url === '/cached.mjs') { response.writeHead(304, { 'content-type': 'application/octet-stream' }); response.end(); }
    else if (request.url === '/missing.mjs') { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('missing'); }
    else if (request.url === '/module.wasm') { response.writeHead(200, { 'content-type': 'application/wasm' }); response.end(wasm); }
    else { response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(module); }
  });
  let navigated;
  const driver = await serve(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    navigated = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"value":null}');
  });
  const proxy = await startMimeDriverProxy(driver.origin);
  try {
    const result = await fetch(`${proxy.origin}/session/real/url`, { method: 'POST', body: JSON.stringify({ url: host.origin + '/?test=1#case', extra: 7 }) });
    assert.equal(result.status, 200);
    assert.equal(navigated.extra, 7);
    const origin = new URL(navigated.url).origin;
    assert.equal(new URL(navigated.url).search, '?test=1');
    assert.equal(new URL(navigated.url).hash, '#case');
    for (const path of ['/snippets/runtime/js/retained-driver.mjs', '/smlib/client.mjs']) {
      const response = await fetch(origin + path);
      assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
      assert.equal(await response.text(), module);
    }
    const bootstrap = await fetch(origin + '/run.js', { headers: { 'if-none-match': 'upstream' } });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.headers.get('etag'), null);
    assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
    assert.equal(await bootstrap.text(), "shim + 'import ' + JSON.stringify(scriptUrl) + ';'");
    const cached = await fetch(origin + '/cached.mjs');
    assert.equal(cached.status, 304);
    assert.equal(cached.headers.get('content-type'), 'text/javascript; charset=utf-8');
    const binary = await fetch(origin + '/module.wasm');
    assert.equal(binary.headers.get('content-type'), 'application/wasm');
    assert.deepEqual(Buffer.from(await binary.arrayBuffer()), wasm);
    const missing = await fetch(origin + '/missing.mjs');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('content-type'), 'text/plain');
    assert.equal(await missing.text(), 'missing');
  } finally { await proxy.close(); await driver.close(); await host.close(); }
});

test('driver commands and actual upstream errors remain intact', async () => {
  const seen = [];
  const driver = await serve(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    seen.push({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString() });
    response.writeHead(418, { 'content-type': 'application/json' }); response.end('{"value":{"error":"actual upstream error"}}');
  });
  const proxy = await startMimeDriverProxy(driver.origin);
  try {
    const body = '{"script":"return 1","args":[]}';
    const response = await fetch(proxy.origin + '/session/real/execute/sync', { method: 'POST', body });
    assert.equal(response.status, 418);
    assert.equal(await response.text(), '{"value":{"error":"actual upstream error"}}');
    assert.deepEqual(seen, [{ method: 'POST', path: '/session/real/execute/sync', body }]);
  } finally { await proxy.close(); await driver.close(); }
});

// Invariant: the native Worker receives a static module graph, so its event
// queue cannot run during an asynchronous dynamic-import bootstrap gap.
test('runner bootstrap keeps real worker loading static and preserves classic workers', () => {
  const fixture = `const wrapper = isModule
    ? shim + 'await import(' + JSON.stringify(scriptUrl) + ');'
    : shim + 'importScripts(' + JSON.stringify(scriptUrl) + ');'; wrapper;`;
  const repaired = repairWorkerBootstrap(fixture);
  const values = { shim: '/*console shim*/', scriptUrl: 'http://localhost/actual-worker.mjs' };
  assert.equal(vm.runInNewContext(repaired, { ...values, isModule: true }),
    '/*console shim*/import "http://localhost/actual-worker.mjs";');
  assert.equal(vm.runInNewContext(repaired, { ...values, isModule: false }),
    vm.runInNewContext(fixture, { ...values, isModule: false }));
  assert.throws(() => repairWorkerBootstrap('unknown runner'), /unrecognized/);
});
