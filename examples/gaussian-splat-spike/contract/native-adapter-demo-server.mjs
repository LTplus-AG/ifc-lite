/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8564 demo server: the spike's vite.config.mjs (its /fixtures middleware for
// FZK, the two .splat captures and the published wasm) plus ONE explicit-path
// route for the licensed Seem Kirke PLY, served only after its size and SHA-256
// match tests/models/manifest.json. No arbitrary path is ever exposed.
//   node examples/gaussian-splat-spike/contract/native-adapter-demo-server.mjs [--port=5181]
// Then open the printed URL (append ?capture=seem for the church).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { isMainEntry } from '../../../scripts/lib/is-main-entry.mjs';

const spike = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(spike, '../..');
export const SEEM_ROUTE = '/fixtures-explicit/seem-kirke-v1.ply';
const SEEM_PATH = 'gaussian/seem-kirke-v1.ply';

async function firstExisting(paths) {
  for (const path of paths) {
    try { await access(path); return path; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

/** Resolve the PLY (env, repo fixture, then the local fixture cache) and pin it to the manifest entry. */
export async function seemFixture() {
  const manifest = JSON.parse(await readFile(resolve(repo, 'tests/models/manifest.json'), 'utf8'));
  const entry = manifest.files.find(file => file.path === SEEM_PATH);
  if (!entry) throw new Error(`${SEEM_PATH} missing from tests/models/manifest.json`);
  const path = await firstExisting([process.env.SPLAT_SPIKE_SEEM_PLY, resolve(repo, 'tests/models', SEEM_PATH),
    resolve(homedir(), 'ifc-fixtures', SEEM_PATH)].filter(Boolean));
  return { path, size: entry.size, sha256: entry.sha256, gaussian: entry.gaussian };
}

async function verify({ path, size, sha256 }) {
  if (!path) return { ok: false, status: 404, reason: `not found (pnpm fixtures ${SEEM_PATH}, or set SPLAT_SPIKE_SEEM_PLY)` };
  const info = await stat(path);
  if (info.size !== size) return { ok: false, status: 403, reason: `size ${info.size} != manifest ${size}` };
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const actual = hash.digest('hex');
  return actual === sha256 ? { ok: true, path, size } : { ok: false, status: 403, reason: `sha256 ${actual} != manifest ${sha256}` };
}

export function seemFixturePlugin() {
  let verdict = null;
  return { name: 'native-adapter-seem-fixture-8564', configureServer(server) {
    server.middlewares.use(SEEM_ROUTE, async (req, res) => {
      try {
        // Cache only a verified fixture, so `pnpm fixtures` or a fix applies on reload.
        const pending = (verdict ??= seemFixture().then(verify));
        const checked = await pending.catch((error) => { if (verdict === pending) verdict = null; throw error; });
        if (!checked.ok && verdict === pending) verdict = null;
        if (!checked.ok) { console.error(`[seem fixture] refused: ${checked.reason}`); res.writeHead(checked.status).end(checked.reason); return; }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', checked.size);
        createReadStream(checked.path).on('error', error => { console.error(error); res.destroy(error); }).pipe(res);
      } catch (error) {
        console.error('[seem fixture]', error);
        res.writeHead(500).end();
      }
    });
  } };
}

export async function startDemoServer({ port = 5181 } = {}) {
  const server = await createServer({
    root: spike, configFile: resolve(spike, 'vite.config.mjs'), logLevel: 'warn', plugins: [seemFixturePlugin()],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port, strictPort: port !== 0, fs: { allow: [repo] } },
  });
  await server.listen();
  return server;
}

if (isMainEntry(import.meta.url)) {
  const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? 5181);
  const server = await startDemoServer({ port });
  const base = `${server.resolvedUrls.local[0]}contract/native-adapter-demo.html`;
  console.log(`Internal unqualified Gaussian adapter preview — not production\n  FZK + licensed captures: ${base}\n  FZK + Seem Kirke:        ${base}?capture=seem\n  30 s journey autoplay:   append &journey=1 (or ?journey=1)`);
}
