/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// HTTPS front for the #9523 browser evidence: serves `/__probe/*` from a directory and proxies every other
// path to an upstream http server (the built viewer's `vite preview`), keeping its headers. The certificate
// is self-signed for one hostname; the browser is told to ignore certificate errors and to resolve that
// hostname to 127.0.0.1. Usage: node https-front.mjs <port> <cert.pem> <key.pem> <probeDir> [upstreamOrigin]
import { createServer } from 'node:https';
import { request } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

const [port, cert, key, probeDir, upstream] = process.argv.slice(2);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const url = new URL(req.url, 'https://front');
  if (url.pathname.startsWith('/__probe/')) {
    const file = normalize(join(probeDir, url.pathname.slice('/__probe/'.length)));
    if (!file.startsWith(normalize(probeDir)) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
    return;
  }
  if (!upstream) { res.writeHead(404).end(); return; }
  const up = new URL(upstream);
  const fwd = request({ host: up.hostname, port: up.port, path: req.url, method: req.method,
    headers: { ...req.headers, host: up.host } }, (upRes) => { res.writeHead(upRes.statusCode ?? 502, upRes.headers); upRes.pipe(res); });
  fwd.on('error', (err) => { res.writeHead(502).end(String(err)); });
  req.pipe(fwd);
});
server.listen(Number(port), '127.0.0.1', () => console.log(`https-front listening on 127.0.0.1:${port}`));
