/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer HTTP server — serves the WebGL viewer and exposes a REST API
 * for external tools to send live commands.
 *
 * This module is framework-agnostic; the CLI wraps it with arg parsing
 * and stdin interaction.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getViewerHtml } from './viewer-html.js';

/** Valid command actions that the viewer understands */
export const VALID_ACTIONS = new Set([
  'colorize', 'isolate', 'xray', 'flyto', 'highlight',
  'colorizeEntities', 'isolateEntities', 'hideEntities', 'showEntities', 'resetColorEntities',
  'section', 'clearSection', 'colorByStorey', 'addGeometry',
  'showall', 'reset', 'picked', 'setView', 'removeCreated', 'camera',
]);

/** MIME types for served files */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ifc': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
};

/** Result from the create handler */
export interface CreateResult {
  content: string;
  entities: unknown[];
  stats: { fileSize: number };
}

/** Handler for /api/create — injected by the CLI to avoid circular deps */
export type CreateHandler = (elements: Array<{
  type: string;
  params?: Record<string, unknown>;
  storey?: string;
  project?: string;
}>) => Promise<CreateResult>;

export interface ViewerServerOptions {
  /** Path to IFC file to serve (null for empty mode) */
  filePath: string | null;
  /** Display name for the model */
  fileName: string;
  /** Port to listen on (0 = auto) */
  port: number;
  /** Optional handler for /api/create endpoint */
  createHandler?: CreateHandler;
  /** Callback when server is ready */
  onReady?: (port: number, url: string) => void;
  /** Callback on server error */
  onError?: (err: NodeJS.ErrnoException) => void;
}

export interface ViewerServer {
  /** Broadcast a command to all connected viewers */
  broadcast: (data: Record<string, unknown>) => void;
  /** Active SSE client count */
  clientCount: () => number;
  /** Created IFC segments (for export) */
  createdSegments: string[];
  /** Close the server */
  close: () => void;
}

/** Resolve the path to @ifc-lite/wasm package */
export function resolvePackageDirFromModuleUrl(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

export function resolveWasmAssetPath(wasmDir: string, requestPath: string): string | null {
  if (!requestPath.startsWith('/wasm/')) {
    return null;
  }

  const relativePath = requestPath.slice('/wasm/'.length);
  if (!relativePath) {
    return null;
  }

  const pkgDir = resolve(wasmDir, 'pkg');
  const assetPath = resolve(pkgDir, relativePath);
  const rel = relative(pkgDir, assetPath);
  if (rel.startsWith('..') || rel === '') {
    return null;
  }

  return assetPath;
}

async function resolveWasmDir(): Promise<string> {
  try {
    // Use import.meta.resolve which understands ESM "exports" maps
    const entryUrl = import.meta.resolve('@ifc-lite/wasm');
    // entryUrl = file:///…/packages/wasm/pkg/ifc-lite.js → we need …/packages/wasm
    return resolvePackageDirFromModuleUrl(entryUrl);
  } catch {
    // Fallback: resolve from the sibling @ifc-lite/wasm package directory.
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wasm');
  }
}

/** Read full request body as string */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export async function startViewerServer(opts: ViewerServerOptions): Promise<ViewerServer> {
  const { filePath, fileName, port: requestedPort, createHandler } = opts;

  // Validate file exists (size is re-stat'd per /model.ifc request)
  if (filePath) {
    await stat(filePath);
  }

  const wasmDir = await resolveWasmDir();

  // Read WASM assets
  const wasmJs = await readFile(resolve(wasmDir, 'pkg', 'ifc-lite.js'));
  const wasmBinary = await readFile(resolve(wasmDir, 'pkg', 'ifc-lite_bg.wasm'));
  const wasmJsCached = wasmJs.toString().replace(
    /new URL\('ifc-lite_bg\.wasm', import\.meta\.url\)/g,
    "new URL('/wasm/ifc-lite_bg.wasm', location.origin)",
  );

  const viewerHtml = getViewerHtml(fileName);

  // SSE clients
  const sseClients: Set<ServerResponse> = new Set();

  function broadcast(data: Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      res.write(payload);
    }
  }

  // Track IFC content created via /api/create for export
  const createdSegments: string[] = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    // CORS headers — restrict to localhost origins only
    const origin = req.headers.origin ?? '';
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Routes
    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(viewerHtml);
      return;
    }

    if (path === '/model.ifc' && req.method === 'GET') {
      if (!filePath) {
        res.writeHead(204);
        res.end();
        return;
      }
      // Re-stat per request so Content-Length always matches the streamed body
      // even if the file was modified/truncated since server start.
      const { size } = await stat(filePath);
      res.writeHead(200, {
        'Content-Type': MIME['.ifc'],
        'Content-Length': size.toString(),
      });
      createReadStream(filePath).pipe(res);
      return;
    }

    if (path === '/wasm/ifc-lite.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': MIME['.js'] });
      res.end(wasmJsCached);
      return;
    }

    if (path === '/wasm/ifc-lite_bg.wasm' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': MIME['.wasm'],
        'Content-Length': wasmBinary.byteLength.toString(),
      });
      res.end(wasmBinary);
      return;
    }

    if (path.startsWith('/wasm/snippets/') && req.method === 'GET') {
      const assetPath = resolveWasmAssetPath(wasmDir, path);
      if (!assetPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      try {
        const asset = await readFile(assetPath);
        res.writeHead(200, {
          'Content-Type': MIME[extname(assetPath)] ?? 'application/octet-stream',
          'Content-Length': asset.byteLength.toString(),
        });
        res.end(asset);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
      return;
    }

    // SSE endpoint
    if (path === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('data: {"action":"connected"}\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // Command API
    if (path === '/api/command' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const command = JSON.parse(body);
        if (!command.action || !VALID_ACTIONS.has(command.action)) {
          res.writeHead(400, { 'Content-Type': MIME['.json'] });
          res.end(JSON.stringify({
            ok: false,
            error: `Unknown action: ${command.action ?? '(none)'}`,
            validActions: [...VALID_ACTIONS],
          }));
          return;
        }
        broadcast(command);
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: true, action: command.action, clients: sseClients.size }));
      } catch (e: unknown) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
      return;
    }

    // Create element API
    if (path === '/api/create' && req.method === 'POST') {
      if (!createHandler) {
        res.writeHead(501, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: false, error: 'Create handler not configured' }));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        const elements = Array.isArray(parsed) ? parsed : [parsed];

        if (elements.length === 0 || !elements[0].type) {
          res.writeHead(400, { 'Content-Type': MIME['.json'] });
          res.end(JSON.stringify({ ok: false, error: 'Missing "type" field' }));
          return;
        }

        const result = await createHandler(elements);

        broadcast({ action: 'addGeometry', ifcContent: result.content });
        createdSegments.push(result.content);

        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({
          ok: true,
          count: elements.length,
          entities: result.entities,
          ifcSize: result.stats.fileSize,
        }));
      } catch (e: unknown) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
      return;
    }

    // Clear created geometry
    if (path === '/api/clear-created' && req.method === 'POST') {
      const count = createdSegments.length;
      createdSegments.length = 0;
      broadcast({ action: 'removeCreated' });
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ ok: true, cleared: count }));
      return;
    }

    // Export created geometry
    if (path === '/api/export' && req.method === 'GET') {
      if (createdSegments.length === 0) {
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: false, error: 'No geometry has been created yet' }));
        return;
      }
      const combined = createdSegments.join('\n');
      res.writeHead(200, {
        'Content-Type': MIME['.ifc'],
        'Content-Disposition': `attachment; filename="created-${fileName}"`,
        'Content-Length': Buffer.byteLength(combined).toString(),
      });
      res.end(combined);
      return;
    }

    // Status
    if (path === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({
        ok: true,
        model: fileName,
        clients: sseClients.size,
        createdSegments: createdSegments.length,
      }));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (opts.onError) {
      opts.onError(err);
    }
  });

  return new Promise((promiseResolve) => {
    server.listen(requestedPort, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : requestedPort;
      const url = `http://localhost:${port}`;

      if (opts.onReady) {
        opts.onReady(port, url);
      }

      promiseResolve({
        broadcast,
        clientCount: () => sseClients.size,
        createdSegments,
        close: () => server.close(),
      });
    });
  });
}
