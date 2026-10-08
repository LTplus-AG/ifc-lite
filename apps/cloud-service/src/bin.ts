/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createCloudHandler } from './handler.js';
import { cloudHttpServer } from './http-server.js';
import type { AppCredentials } from './config.js';
function credentials(prefix: string): AppCredentials | undefined {
  const clientId = process.env[`${prefix}_CLIENT_ID`]; const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) throw new Error(`Configure both ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET.`);
  return { clientId, clientSecret, tenant: prefix === 'CLOUD_MICROSOFT' ? process.env.CLOUD_MICROSOFT_TENANT : undefined };
}
const origin = process.env.CLOUD_VIEWER_ORIGIN ?? '';
const handler = createCloudHandler({ origin, apps: { dropbox: credentials('CLOUD_DROPBOX'), msgraph: credentials('CLOUD_MICROSOFT') }, insecureLocalhost: process.env.CLOUD_INSECURE_LOCALHOST === 'true', downloadDirectory: process.env.CLOUD_DOWNLOAD_DIRECTORY });
await handler.ready;
const port = Number(process.env.PORT ?? 3004);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid cloud service port.');
const server = cloudHttpServer(origin, handler.handle).listen(port, process.env.CLOUD_SERVICE_HOST ?? '127.0.0.1', () => console.info(`Cloud service listening on port ${port}`));
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return; stopping = true;
  server.close(); server.closeIdleConnections();
  const timeout = setTimeout(() => { console.warn('Cloud shutdown deadline reached'); server.closeAllConnections(); process.exit(0); }, 6000); timeout.unref();
  await handler.close(); server.closeAllConnections();
}
process.once('SIGTERM', () => { void stop().catch(() => { console.error('Cloud shutdown failed'); process.exitCode = 1; }); });
process.once('SIGINT', () => { void stop().catch(() => { console.error('Cloud shutdown failed'); process.exitCode = 1; }); });
