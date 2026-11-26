/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared command line runtime (#11534): a read-only HTTP session can
 * load a model, HTTP mode honours --allow and warns about file arguments it
 * would ignore, tokens repeat, and the help names the right Claude Desktop
 * config path.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseArgs } from './cli-args.js';
import { mcpHelpText, runMcpCli, type RunningHttpCli } from './cli-main.js';
import { anonymousHttpScope, claudeDesktopConfigPath, loadFiles, serverScope, tokenScopes } from './cli-support.js';
import { InMemoryModelRegistry } from './context.js';

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0PROJ000000000000000000',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#72= IFCWALL('0WALL00000000000000000',$,'Wall',$,$,#40,$,'tag',$);
ENDSEC;
END-ISO-10303-21;
`;

interface RpcResult {
  result?: { tools?: Array<{ name: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
}

class Client {
  sessionId?: string;
  private nextId = 1;
  constructor(private port: number, private token: string) {}

  async rpc(method: string, params: unknown): Promise<RpcResult> {
    const res = await fetch(`http://127.0.0.1:${this.port}/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    });
    expect(res.status).toBe(200);
    this.sessionId ??= res.headers.get('mcp-session-id') ?? undefined;
    return (await res.json()) as RpcResult;
  }

  initialize(): Promise<RpcResult> {
    return this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli-main-test', version: '0' } });
  }

  call(name: string, args: Record<string, unknown>): Promise<RpcResult> {
    return this.rpc('tools/call', { name, arguments: args });
  }
}

describe('HTTP mode of runMcpCli (#11534)', () => {
  let dir: string;
  let outside: string;
  let modelPath: string;
  let running: RunningHttpCli | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-cli-main-'));
    outside = await mkdtemp(join(tmpdir(), 'mcp-cli-outside-'));
    modelPath = join(dir, 'model.ifc');
    await writeFile(modelPath, MODEL);
    await writeFile(join(outside, 'other.ifc'), MODEL);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    running = await runMcpCli(
      ['--transport', 'http', '--port', '0', '--read-only', '--read-only-token', 'ro', '--token', 'full', '--allow', dir],
      { command: 'ifc-lite-mcp' },
    );
  });

  afterAll(async () => {
    await running?.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('lets a read-only session load and unload models', async () => {
    const client = new Client(running!.port, 'ro');
    await client.initialize();
    const tools = (await client.rpc('tools/list', {})).result?.tools?.map((t) => t.name) ?? [];
    expect(tools).toContain('model_load');
    expect(tools).toContain('model_unload');
    // A mutation tool stays hidden under --read-only.
    expect(tools).not.toContain('entity_set_property');

    const loaded = await client.call('model_load', { file_path: modelPath, model_id: 'm' });
    expect(loaded.result?.isError).toBeFalsy();
    expect(loaded.result?.structuredContent?.id).toBe('m');
    const unloaded = await client.call('model_unload', { model_id: 'm' });
    expect(unloaded.result?.isError).toBeFalsy();
    expect((await client.call('model_list', {})).result?.structuredContent?.count).toBe(0);
  });

  // #2731: --allow means the same over HTTP as over stdio.
  it('still refuses a path outside --allow', async () => {
    const client = new Client(running!.port, 'ro');
    await client.initialize();
    const refused = await client.call('model_load', { file_path: join(outside, 'other.ifc') });
    expect(refused.result?.isError).toBe(true);
  });

  it('keeps another token out of a session even when the scopes match', async () => {
    const owner = new Client(running!.port, 'full');
    await owner.initialize();
    const res = await fetch(`http://127.0.0.1:${running!.port}/`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ro', 'Content-Type': 'application/json', 'Mcp-Session-Id': owner.sessionId! },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(403);
  });

  it('exits with a usage error when a value flag has no value', async () => {
    const before = process.exitCode;
    try {
      await expect(runMcpCli(['--transport', 'http', '--token'], { command: 'ifc-lite-mcp' })).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = before;
    }
  });

  // Configs from before #11534 pass files over HTTP: keep them starting, but say the files load nothing.
  it('warns about file arguments over HTTP and still starts', async () => {
    const stderr = vi.mocked(process.stderr.write);
    stderr.mockClear();
    const server = await runMcpCli(['--transport', 'http', '--port', '0', modelPath], { command: 'ifc-lite-mcp' });
    try {
      expect(server?.port).toBeGreaterThan(0);
      const said = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(said).toMatch(/does not preload files \(1 file argument\(s\) ignored\)/);
      expect(said).not.toContain(modelPath); // a mistyped flag's value may sit among the files
    } finally {
      await server?.close();
    }
  });
});

describe('stdio file arguments (#11534)', () => {
  let dir: string;
  let outsideFile: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-cli-files-'));
    outsideFile = join(await mkdtemp(join(tmpdir(), 'mcp-cli-files-out-')), 'secret-token.ifc');
    await writeFile(outsideFile, MODEL);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(resolve(outsideFile, '..'), { recursive: true, force: true });
  });

  // `--tokn s3cret` warns about --tokn and leaves `s3cret` as a file: the error must not print it.
  it('names a file that fails to load by position, never by its value', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // runStdio routes console output to stderr for the process; undo that here.
    const consoleBefore = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
    const routed = Symbol.for('ifc-lite.mcp.console-to-stderr');
    try {
      const missing = await runMcpCli(['--tokn', 's3cret-value'], { command: 'ifc-lite-mcp' }).catch((e: unknown) => e);
      expect(String(missing)).toMatch(/file argument 1 of 1 could not be loaded \(ENOENT\)/);
      expect(String(missing)).not.toContain('s3cret');
      // An existing file outside --allow: the loader's message names the path, the CLI must not.
      const outside = await runMcpCli(['--allow', dir, '--tokn', outsideFile], { command: 'ifc-lite-mcp' }).catch((e: unknown) => e);
      expect(String(outside)).toMatch(/file argument 1 of 1 could not be loaded \(outside --allow\)/);
      expect(String(outside)).not.toContain(outsideFile);
    } finally {
      Object.assign(console, consoleBefore);
      delete (console as unknown as Record<symbol, unknown>)[routed];
      vi.restoreAllMocks();
    }
  });
});

describe('loadFiles (#11534)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-cli-load-'));
    for (const sub of ['arch', 'struct']) {
      await mkdir(join(dir, sub));
      await writeFile(join(dir, sub, 'model.ifc'), MODEL);
    }
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('gives same-named files their own id and loads a repeated file once', async () => {
    const registry = new InMemoryModelRegistry();
    const lines: string[] = [];
    const arch = join(dir, 'arch', 'model.ifc');
    // A symlink to arch/model.ifc: only a real-path comparison sees it as a repeat.
    const link = join(dir, 'link.ifc');
    await symlink(arch, link);
    try {
      const repeat = join(dir, 'arch', '..', 'arch', 'model.ifc');
      await loadFiles(registry, parseArgs([arch, join(dir, 'struct', 'model.ifc'), link, repeat]), (line) => lines.push(line));
      expect(registry.list().map((m) => m.id)).toEqual(['model', 'model_2']);
      expect(lines).toContain('warning: file argument 3 of 4 repeats file argument 1; skipped');
      expect(lines).toContain('warning: file argument 4 of 4 repeats file argument 1; skipped');
    } finally {
      for (const m of registry.list()) registry.remove(m.id);
    }
  });

  // Same policy as model_load (resolveSafePath): a linked --allow root also
  // admits files spelled through its real path, but a file spelled through a
  // link must itself sit under a root, whatever its target.
  it('accepts a real-path file under a linked root, and refuses a linked file under a real root', async () => {
    const linkedRoot = join(await mkdtemp(join(tmpdir(), 'mcp-cli-load-link-')), 'root');
    await symlink(dir, linkedRoot);
    const real = await realpath(dir);
    const registry = new InMemoryModelRegistry();
    try {
      await loadFiles(registry, parseArgs(['--allow', linkedRoot, join(real, 'arch', 'model.ifc')]), () => {});
      expect(registry.list().map((m) => m.id)).toEqual(['model']);
      await expect(loadFiles(new InMemoryModelRegistry(), parseArgs(['--allow', real, join(linkedRoot, 'arch', 'model.ifc')]), () => {}))
        .rejects.toThrow(/\(outside --allow\)/);
    } finally {
      for (const m of registry.list()) registry.remove(m.id);
      await rm(resolve(linkedRoot, '..'), { recursive: true, force: true });
    }
  });

  it('reports a missing file under --allow as ENOENT', async () => {
    await expect(loadFiles(new InMemoryModelRegistry(), parseArgs(['--allow', dir, join(dir, 'typo.ifc')]), () => {}))
      .rejects.toThrow(/file argument 1 of 1 could not be loaded \(ENOENT\)/);
  });

  // A symlink inside --allow that points outside it must be refused, not followed.
  it('refuses a symlink that leaves the --allow root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'mcp-cli-load-out-'));
    await writeFile(join(outside, 'target.ifc'), MODEL);
    const link = join(dir, 'arch', 'escape.ifc');
    await symlink(join(outside, 'target.ifc'), link);
    const registry = new InMemoryModelRegistry();
    try {
      await expect(loadFiles(registry, parseArgs(['--allow', dir, link]), () => {}))
        .rejects.toThrow(/file argument 1 of 1 could not be loaded \(outside --allow\)/);
      expect(registry.list()).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('tokenScopes (#11534)', () => {
  it('gives --token the server scope and --read-only-token read scope', () => {
    const scopes = tokenScopes(parseArgs(['--token', 'a', '--token', 'b', '--read-only-token', 'r']));
    expect([...scopes.keys()]).toEqual(['a', 'b', 'r']);
    expect(scopes.get('a')?.scopes).toContain('mutate');
    expect(scopes.get('b')?.scopes).toContain('mutate');
    expect(scopes.get('r')?.scopes).not.toContain('mutate');
  });

  it('gives each token its own identity, so equal scopes do not share sessions', () => {
    const scopes = [...tokenScopes(parseArgs(['--token', 'a', '--token', 'b', '--read-only-token', 'r'])).values()];
    expect(new Set(scopes.map((s) => s.session)).size).toBe(3);
    // No principal: one derived from argv order would pass to another token
    // on restart, and one derived from the token would put its hash in
    // durable files (BCF journal, layer authorship).
    expect(scopes.every((s) => s.user === undefined)).toBe(true);
  });

  it('narrows every token under --read-only, and a doubly listed token to read', () => {
    expect(tokenScopes(parseArgs(['--read-only', '--token', 'a'])).get('a')?.scopes).not.toContain('mutate');
    expect(tokenScopes(parseArgs(['--token', 'a', '--read-only-token', 'a'])).get('a')?.scopes).not.toContain('mutate');
  });
});

describe('anonymousHttpScope (#11534)', () => {
  it('never grants admin to an HTTP caller without a token', () => {
    expect(anonymousHttpScope(parseArgs([])).scopes.sort()).toEqual(['export', 'mutate', 'read', 'validate']);
    expect(anonymousHttpScope(parseArgs(['--read-only'])).scopes).not.toContain('admin');
    // A --token still grants full scope, admin included, as documented.
    expect(tokenScopes(parseArgs(['--token', 't'])).get('t')?.scopes).toContain('admin');
    // stdio keeps full scope: the local user owns the process.
    expect(serverScope(parseArgs([])).scopes).toContain('admin');
  });
});

describe('help text (#11534)', () => {
  it('names the Claude Desktop config path of each OS', () => {
    expect(claudeDesktopConfigPath('darwin', '/Users/u')).toBe('/Users/u/Library/Application Support/Claude/claude_desktop_config.json');
    expect(claudeDesktopConfigPath('win32', 'C:\\Users\\u')).toBe('%APPDATA%\\Claude\\claude_desktop_config.json');
    expect(claudeDesktopConfigPath('linux', '/home/u')).toBe('/home/u/.config/Claude/claude_desktop_config.json');
    expect(mcpHelpText({ command: 'ifc-lite mcp' }, 'darwin')).toContain('Library/Application Support/Claude');
  });

  it('uses the invoking command name and no longer offers --federate', () => {
    const help = mcpHelpText({ command: 'ifc-lite mcp' });
    expect(help).toContain('Usage: ifc-lite mcp [files…]');
    expect(help).not.toContain('--federate');
  });
});

describe('Claude Code plugin manifest (#11534)', () => {
  it('pins @ifc-lite/mcp to the workspace major and passes only flags the parser knows', async () => {
    const manifestPath = resolve(fileURLToPath(import.meta.url), '../../../../.claude/.claude-plugin/plugin.json');
    const pkgVersion = (JSON.parse(await readFile(resolve(fileURLToPath(import.meta.url), '../../package.json'), 'utf8')) as { version: string }).version;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const servers = Object.values(manifest.mcpServers);
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) {
      const pkg = server.args.find((a) => a.startsWith('@ifc-lite/mcp'));
      // A bare name runs whatever npm has, including a future major. The pin
      // is the workspace major only: a range like `>=x <y` breaks on Windows,
      // where npx.cmd runs through cmd.exe and `<`/`>` redirect, and a floor
      // above the published version matches nothing until it is released.
      expect(pkg).toBe(`@ifc-lite/mcp@${pkgVersion.split('.')[0]}`);
      const flags = server.args.slice(server.args.indexOf(pkg!) + 1);
      expect(parseArgs(flags).warnings).toEqual([]);
      expect(parseArgs(flags).errors).toEqual([]);
    }
  });
});
