/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The offline harness that ends the CesiumOverlay shard-12 timeout (see
 * `no-external-network.mjs`). It is loaded by the viewer `test` script's
 * `--import`, so this file exercises the instance every test file gets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from 'node:https';
import net from 'node:net';
import { queryTerrainElevation } from '@/lib/geo/reproject';

// Read before this file imports the module itself: proves the `--import` wiring.
const installedByHarness = net.Socket.prototype.connect.name === 'connectLoopbackOnly';
const { connectTarget, isLoopback } = await import('./no-external-network.mjs');

const tcpHandles = () => process.getActiveResourcesInfo().filter((name) => name === 'TCPSocketWrap').length;

describe('viewer tests run offline (CesiumOverlay shard-12 timeout, PR #8500)', () => {
  it('is installed by the viewer test script for every test file, not by the file that needs it', () => {
    assert.ok(installedByHarness, 'vite-module-hooks.mjs must import no-external-network.mjs');
  });

  it('refuses an external fetch at once instead of leaving a connect pending', async () => {
    const before = tcpHandles();
    const started = performance.now();
    const failure = await fetch('https://api.open-meteo.com/v1/elevation?latitude=47&longitude=8').then(
      () => assert.fail('an external fetch must not succeed under the viewer tests'),
      (error: unknown) => error,
    );
    assert.ok(failure instanceof Error);
    assert.equal((failure.cause as NodeJS.ErrnoException | undefined)?.code, 'ECONNREFUSED');
    assert.ok(performance.now() - started < 1000, 'refused before DNS, not after a connect timeout');
    // A destroyed handle closes a few loop turns later; a pending connect never does.
    for (let turn = 0; turn < 100 && tcpHandles() > before; turn += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(tcpHandles(), before, 'no socket is left holding the event loop');
  });

  it('lets queryTerrainElevation take its offline fallback, the path the Cesium tests reach', async () => {
    assert.equal(await queryTerrainElevation({ lat: 47.37, lon: 8.54 }), null);
  });

  it('refuses node:https too, which is what happy-dom fetch uses', async () => {
    const code = await new Promise<string | undefined>((resolve) => {
      request('https://tile.openstreetmap.org/0/0/0.png', () => resolve('connected'))
        .on('error', (error: NodeJS.ErrnoException) => resolve(error.code))
        .end();
    });
    assert.equal(code, 'ECONNREFUSED');
  });

  it('still reaches a loopback peer, which is how tests that need HTTP run one', async (t) => {
    const server = createServer((_request, response) => response.end('local'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(await (await fetch(`http://127.0.0.1:${address.port}/`)).text(), 'local');
    assert.equal(await (await fetch(`http://localhost:${address.port}/`)).text(), 'local');
  });

  it('reads every Socket#connect argument shape', () => {
    assert.deepEqual(connectTarget([{ host: 'example.org', port: 443 }]), { host: 'example.org', port: 443 });
    assert.deepEqual(connectTarget([[{ host: 'example.org', port: 80 }, () => {}]]), { host: 'example.org', port: 80 });
    assert.deepEqual(connectTarget([8080, 'example.org']), { host: 'example.org', port: 8080 });
    assert.deepEqual(connectTarget([8080]), { host: 'localhost', port: 8080 });
    assert.equal(connectTarget([{ path: '/tmp/socket' }]), null);
    assert.equal(connectTarget(['/tmp/socket']), null);
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '0.0.0.0']) assert.ok(isLoopback(host), host);
    for (const host of ['api.open-meteo.com', '10.0.0.1', '128.0.0.1', 'localhost.example.org']) assert.ok(!isLoopback(host), host);
  });
});
