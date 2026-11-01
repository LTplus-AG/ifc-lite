/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { defineConfig } from 'vite';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultAssets } from './prepare.mjs';
const repo = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  resolve: { alias: { '@ifc-lite/spatial': resolve(repo, 'packages/spatial/src/index.ts'), '@ifc-lite/load-trace': resolve(repo, 'packages/load-trace/src/index.ts') } },
  server: { host: '127.0.0.1', fs: { allow: [repo] } },
  plugins: [{ name: 'local-spike-fixtures', configureServer(server) {
    const root = resolve(process.env.SPLAT_SPIKE_ASSETS ?? defaultAssets);
    server.middlewares.use('/fixtures', async (req, res) => {
      try {
        const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const path = route === '/model.ifc' && process.env.SPLAT_SPIKE_IFC
          ? resolve(process.env.SPLAT_SPIKE_IFC) : resolve(root, '.' + route);
        if (!(route === '/model.ifc' && process.env.SPLAT_SPIKE_IFC) && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
        const info = await stat(path);
        if (!info.isFile()) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.setHeader('Content-Length', info.size);
        createReadStream(path).on('error', error => { console.error(error); res.destroy(error); }).pipe(res);
      } catch (error) {
        if (error.code !== 'ENOENT') console.error(error);
        res.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
      }
    });
  } }],
});
