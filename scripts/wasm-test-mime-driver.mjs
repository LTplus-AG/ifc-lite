#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// ChromeDriver adapter for wasm-bindgen-test's .mjs HTTP MIME omission.
// Geometry, module bytes, WebDriver commands and assertions are never mocked.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { isMainEntry } from './lib/is-main-entry.mjs';

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}
function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function forward(request, response, target, body, moduleMime = false) {
  const url = new URL(request.url, target);
  const headers = { ...request.headers, host: url.host };
  if (body !== undefined) {
    delete headers['transfer-encoding'];
    headers['content-length'] = body.length;
  }
  const upstream = http.request(url, { method: request.method, headers }, result => {
    const outputHeaders = { ...result.headers };
    if (moduleMime && result.statusCode === 200 && url.pathname.endsWith('.mjs')) {
      outputHeaders['content-type'] = 'text/javascript; charset=utf-8';
    }
    response.writeHead(result.statusCode, outputHeaders);
    result.pipe(response);
  });
  upstream.on('error', error => {
    console.error('wasm test HTTP forwarding failed:', error.message);
    if (!response.headersSent) response.writeHead(502);
    response.end(error.message);
  });
  if (body === undefined) request.pipe(upstream);
  else upstream.end(body);
}

/** Real HTTP forwarding; only module Content-Type and navigation origin change. */
export async function startMimeDriverProxy(driverOrigin, port = 0) {
  const hosts = new Map();
  async function moduleHost(origin) {
    if (!hosts.has(origin)) hosts.set(origin, (async () => {
      const server = http.createServer((request, response) => forward(request, response, origin, undefined, true));
      return { server, origin: await listen(server) };
    })());
    return hosts.get(origin);
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !/\/session\/[^/]+\/url$/.test(request.url)) {
        forward(request, response, driverOrigin);
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const url = new URL(input.url);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        throw new Error('wasm test navigation must use a local HTTP server');
      }
      const host = await moduleHost(url.origin);
      const proxy = new URL(host.origin);
      url.host = proxy.host;
      input.url = url.href;
      forward(request, response, driverOrigin, Buffer.from(JSON.stringify(input)));
    } catch (error) {
      console.error('wasm test driver adapter failed:', error.message);
      if (!response.headersSent) response.writeHead(500);
      response.end(JSON.stringify({ value: { error: 'unknown error', message: error.message } }));
    }
  });
  const origin = await listen(server, port);
  return {
    origin,
    async close() {
      await close(server);
      for (const pending of hosts.values()) await close((await pending).server);
    },
  };
}

async function main(args) {
  const executable = process.env.IFCLITE_REAL_CHROMEDRIVER || 'chromedriver';
  if (args.includes('--version') || args.includes('-v')) {
    const result = spawnSync(executable, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  let port;
  const nativeArgs = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index].startsWith('--port=')) port = Number(args[index].slice(7));
    else if (args[index] === '--port') port = Number(args[++index]);
    else nativeArgs.push(args[index]);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('ChromeDriver requires an explicit port');
  const child = spawn(executable, [...nativeArgs, '--port=0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let proxy;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    if (proxy) await proxy.close();
  };
  process.once('SIGINT', () => { void stop().catch(error => console.error(error)); });
  process.once('SIGTERM', () => { void stop().catch(error => console.error(error)); });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    void stop().catch(error => console.error(error));
  });
  try {
  const nativePort = await new Promise((resolve, reject) => {
    let output = '';
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`ChromeDriver exited before readiness (${code})`)));
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      output = (output + chunk.toString()).slice(-8192);
      const match = output.match(/ChromeDriver was started successfully on port (\d+)/);
      if (match) resolve(Number(match[1]));
    });
  });
  proxy = await startMimeDriverProxy(`http://127.0.0.1:${nativePort}`, port);
  if (stopping) { await proxy.close(); return; }
  console.error(`wasm test module MIME proxy ready on ${proxy.origin}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
