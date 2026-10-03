/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A private Vite dev server of this checkout's viewer, for specs that need the
 * page to import viewer modules (`import('/src/...')`), which the shared
 * `vite preview` build cannot serve.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export interface ViewerDevServer {
  url: string;
  close(): Promise<void>;
}

export async function startViewerDevServer(label: string): Promise<ViewerDevServer> {
  const require = createRequire(join(ROOT, 'apps/viewer/package.json'));
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const cacheDir = await mkdtemp(join(tmpdir(), `ifc-${label}-`));
  type Server = { listen(): Promise<void>; close(): Promise<void>; resolvedUrls: { local: string[] } | null };
  let server: Server | undefined;
  const close = async () => {
    try { await server?.close(); }
    finally { await rm(cacheDir, { recursive: true, force: true }); }
  };
  try {
    server = await createServer({ root: join(ROOT, 'apps/viewer'), cacheDir, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    const url = server.resolvedUrls?.local[0] ?? '';
    if (!url) throw new Error(`${label} dev server did not expose its URL`);
    return { url, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `${label} dev server startup and cleanup failed`); }
    throw error;
  }
}
