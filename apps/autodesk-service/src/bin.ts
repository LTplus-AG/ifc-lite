/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { autodeskHttpServer } from './http-server.js';
import { installShutdown } from './shutdown.js';
import { createAutodeskHandler } from './handler.js';
import { formaAdapter } from './forma-adapter.js';
import { exchangeAdapter } from './exchange-adapter.js';

const origin = process.env.AUTODESK_VIEWER_ORIGIN ?? '';
const handler = createAutodeskHandler({
  origin, clientId: process.env.AUTODESK_CLIENT_ID ?? '', clientSecret: process.env.AUTODESK_CLIENT_SECRET ?? '',
  adapters: [
    ...(process.env.AUTODESK_FORMA_CONVERTER ? [formaAdapter(process.env.AUTODESK_FORMA_CONVERTER)] : []),
    ...(process.env.AUTODESK_EXCHANGE_WORKER ? [exchangeAdapter(process.env.AUTODESK_EXCHANGE_WORKER)] : []),
  ],
  insecureLocalhost: process.env.AUTODESK_INSECURE_LOCALHOST === 'true',
});
const port = Number(process.env.AUTODESK_SERVICE_PORT ?? process.env.PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid AUTODESK_SERVICE_PORT.');
const server = autodeskHttpServer(origin, handler).listen(port, process.env.AUTODESK_SERVICE_HOST ?? '127.0.0.1', () => {
  console.info(`Autodesk service listening on port ${port}`);
});
installShutdown(server, () => handler.close());
