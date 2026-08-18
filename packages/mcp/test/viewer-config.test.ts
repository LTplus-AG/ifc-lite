/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ServerConfig.autoOpenViewer` / `.viewerPort` — issue #2731 finding 4.
 *
 * `MCPServer` is public API and its constructor accepts `config: Partial<ServerConfig>`.
 * Both fields were declared on the type and written into `config` by the CLI, but nothing
 * in the server ever read `this.config.autoOpenViewer` / `this.config.viewerPort` — the
 * CLI's own working behaviour came entirely from separate local variables that bypassed
 * the config object. An embedder constructing `MCPServer` directly with
 * `config: { autoOpenViewer: true }` got silently nothing.
 *
 * Precedence (see PR body): explicit override argument to `maybeAutoOpenViewer()` > the
 * `config` object passed to the constructor > built-in defaults (no auto-open, port 0).
 * These three tests pin all three levels.
 */

import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { IfcCreator } from '@ifc-lite/create';
import {
  InMemoryModelRegistry,
  createMCPServer,
  loadIfcModel,
  type MCPServer,
} from '../src/index.js';

let tmp: string;
let ifcPath: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-viewer-config-'));
  ifcPath = join(tmp, 'tiny.ifc');
  const creator = new IfcCreator({ Name: 'Viewer Config Test' });
  const storey = creator.addIfcBuildingStorey({ Name: 'L1', Elevation: 0 });
  creator.addIfcWall(storey, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  await writeFile(ifcPath, creator.toIfc().content, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let liveServer: MCPServer | undefined;

afterEach(() => {
  if (liveServer?.viewer.isOpen()) liveServer.viewer.close();
  liveServer = undefined;
});

async function bootServer(config?: { autoOpenViewer?: boolean; viewerPort?: number }): Promise<MCPServer> {
  const registry = new InMemoryModelRegistry();
  const loaded = await loadIfcModel(ifcPath);
  registry.add(loaded);
  const server = createMCPServer({ version: '0.0.0-test', registry, config });
  liveServer = server;
  return server;
}

/** A port that is free right now — so the assertions below pin a port the
 *  caller chose, not the `0` default that every other case in this file uses
 *  and that therefore cannot distinguish "config honoured" from "default". */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') { probe.close(); reject(new Error('no port')); return; }
      const port = addr.port;
      probe.close(() => resolve(port));
    });
  });
}

describe('ServerConfig.autoOpenViewer / .viewerPort — public API is honoured', () => {
  it('level 3 — neither flag nor config set: no auto-open, defaults win', async () => {
    const server = await bootServer();
    const state = await server.maybeAutoOpenViewer();
    expect(state).toBeNull();
    expect(server.viewer.isOpen()).toBe(false);
  });

  it('level 2 — config set (embedder path), no explicit override: config is honoured', async () => {
    const server = await bootServer({ autoOpenViewer: true, viewerPort: 0 });
    const state = await server.maybeAutoOpenViewer();
    expect(state).not.toBeNull();
    expect(server.viewer.isOpen()).toBe(true);
    expect(state!.url).toMatch(/^http:\/\/localhost:\d+\/$/);
  });

  it('level 1 — explicit override set: wins over a contradicting config value', async () => {
    // Config says "do not auto-open"; the explicit override (standing in for a CLI flag) must win.
    const server = await bootServer({ autoOpenViewer: false });
    const state = await server.maybeAutoOpenViewer({ autoOpen: true, port: 0 });
    expect(state).not.toBeNull();
    expect(server.viewer.isOpen()).toBe(true);
  });

  it('explicit override can also suppress a config that requests auto-open', async () => {
    const server = await bootServer({ autoOpenViewer: true });
    const state = await server.maybeAutoOpenViewer({ autoOpen: false });
    expect(state).toBeNull();
    expect(server.viewer.isOpen()).toBe(false);
  });

  // The cases above all pass `viewerPort: 0` / `port: 0`, which is ALSO the
  // built-in default — so none of them can tell a honoured config port from
  // the default. Confirmed by mutation: dropping `this.config.viewerPort` from
  // the resolution chain killed nothing. These two pin the port half.
  it('config.viewerPort is honoured (a non-default port reaches the viewer)', async () => {
    const port = await freePort();
    const server = await bootServer({ autoOpenViewer: true, viewerPort: port });
    const state = await server.maybeAutoOpenViewer();
    expect(state).not.toBeNull();
    expect(state!.url).toBe(`http://localhost:${port}/`);
  });

  it('an explicit override port wins over a contradicting config port', async () => {
    const configPort = await freePort();
    const overridePort = await freePort();
    expect(overridePort).not.toBe(configPort);
    const server = await bootServer({ autoOpenViewer: true, viewerPort: configPort });
    const state = await server.maybeAutoOpenViewer({ port: overridePort });
    expect(state).not.toBeNull();
    expect(state!.url).toBe(`http://localhost:${overridePort}/`);
  });
});
