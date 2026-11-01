/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer tests run offline: a TCP connection to anything but loopback is
 * refused at once, inside the test process, before DNS.
 *
 * `CesiumOverlay.custom-3dtiles.test.tsx` passed all four tests and then held
 * viewer shard 12 open until its 120 s file timeout (merge-queue PR #8500,
 * 2026-11-01). The stubbed globe has no height, so terrain elevation fell back
 * to `queryTerrainElevation`, which fetched api.open-meteo.com for real, eight
 * times per run. Its 5 s abort bounds the promise, not the socket: on a runner
 * whose route drops the connection, the connect stays pending and keeps the
 * event loop alive, and the file is killed although every test passed.
 *
 * Refusing here turns that into what offline code already handles: the fetch
 * rejects with ECONNREFUSED on the next tick and the caller takes its fallback.
 * A test that needs a peer starts one on 127.0.0.1 (`bcf-http-server.ts`) or
 * stubs `fetch` (`fetch-stub.ts`). Loaded from `vite-module-hooks.mjs`, which
 * the viewer `test` script puts on every test process's `--import`.
 */

import net from 'node:net';

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|0\.0\.0\.0|::|\[::1\])$/i;
const refused = new Set();

/** `connect(options)`, `connect(port, host)` or `connect(path)`; null for IPC. */
export function connectTarget(args) {
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  if (first && typeof first === 'object') {
    return first.path ? null : { host: first.host ?? 'localhost', port: first.port };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  return { host: typeof second === 'string' ? second : 'localhost', port: first };
}

export function isLoopback(host) {
  return LOOPBACK.test(host);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connectLoopbackOnly(...args) {
  const target = connectTarget(args);
  if (!target || isLoopback(target.host)) return connect.apply(this, args);
  const where = `${target.host}:${target.port}`;
  if (!refused.has(where)) {
    refused.add(where);
    console.error(`[no-external-network] refused ${where}: viewer tests run offline (apps/viewer/src/test/no-external-network.mjs)`);
  }
  const error = Object.assign(new Error(`connect ECONNREFUSED ${where} (viewer tests run offline)`), {
    code: 'ECONNREFUSED', syscall: 'connect', address: target.host, port: target.port,
  });
  process.nextTick(() => this.destroy(error));
  return this;
};
