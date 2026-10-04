/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createExchangeWorkerHandler } from './exchange-worker-handler.js';
import { exchangeAdapter } from './exchange-adapter.js';
import { autodeskHttpServer } from './http-server.js';
import { installShutdown } from './shutdown.js';

const command = process.env.AUTODESK_EXCHANGE_WORKER;
if (!command) throw new Error('Configure the absolute AUTODESK_EXCHANGE_WORKER executable path.');
if (process.platform !== 'win32') throw new Error('The Autodesk exchange SDK requires Windows.');
const handler = createExchangeWorkerHandler(process.env.AUTODESK_EXCHANGE_WORKER_KEY ?? '', exchangeAdapter(command));
const port = Number(process.env.AUTODESK_EXCHANGE_WORKER_PORT ?? 3003);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid worker port.');
// Caddy terminates TLS; the worker listens only on loopback.
const server = autodeskHttpServer('http://127.0.0.1:3003', handler).listen(port, '127.0.0.1', () => {
  console.info(`Exchange worker listening on port ${port}`);
});
installShutdown(server, () => handler.close());
