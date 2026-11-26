/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared command line runtime (#11534): a read-only HTTP session can
 * load a model, HTTP mode serves the files it is given and honours --allow,
 * tokens repeat, and the help names the right Claude Desktop config path.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseArgs } from './cli-args.js';
import { claudeDesktopConfigPath, mcpHelpText, runMcpCli, tokenScopes, type RunningHttpCli } from './cli-main.js';

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
  private sessionId?: string;
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
      ['--transport', 'http', '--port', '0', '--read-only', '--read-only-token', 'ro', '--token', 'full', '--allow', dir, modelPath],
      { command: 'ifc-lite-mcp' },
    );
  });

  afterAll(async () => {
    await running?.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('preloads the file arguments into each session', async () => {
    for (const token of ['ro', 'full']) {
      const client = new Client(running!.port, token);
      await client.initialize();
      const listed = await client.call('model_list', {});
      expect(listed.result?.structuredContent?.count).toBe(1);
    }
  });

  it('lets a read-only session load and unload models', async () => {
    const client = new Client(running!.port, 'ro');
    await client.initialize();
    const tools = (await client.rpc('tools/list', {})).result?.tools?.map((t) => t.name) ?? [];
    expect(tools).toContain('model_load');
    expect(tools).toContain('model_unload');
    // A mutation tool stays hidden under --read-only.
    expect(tools).not.toContain('entity_set_property');

    const loaded = await client.call('model_load', { file_path: modelPath, model_id: 'second' });
    expect(loaded.result?.isError).toBeFalsy();
    expect(loaded.result?.structuredContent?.id).toBe('second');
    const unloaded = await client.call('model_unload', { model_id: 'second' });
    expect(unloaded.result?.isError).toBeFalsy();
  });

  // #2731: --allow means the same over HTTP as over stdio.
  it('still refuses a path outside --allow', async () => {
    const client = new Client(running!.port, 'ro');
    await client.initialize();
    const refused = await client.call('model_load', { file_path: join(outside, 'other.ifc') });
    expect(refused.result?.isError).toBe(true);
  });

  it('refuses to start on a file it cannot read', async () => {
    await expect(runMcpCli(['--transport', 'http', '--port', '0', join(dir, 'missing.ifc')], { command: 'ifc-lite-mcp' }))
      .rejects.toThrow(/cannot read/);
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

  it('narrows every token under --read-only, and a doubly listed token to read', () => {
    expect(tokenScopes(parseArgs(['--read-only', '--token', 'a'])).get('a')?.scopes).not.toContain('mutate');
    expect(tokenScopes(parseArgs(['--token', 'a', '--read-only-token', 'a'])).get('a')?.scopes).not.toContain('mutate');
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
  it('pins @ifc-lite/mcp and passes only flags the parser knows', async () => {
    const manifestPath = resolve(fileURLToPath(import.meta.url), '../../../../.claude/.claude-plugin/plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    for (const server of Object.values(manifest.mcpServers)) {
      const pkg = server.args.find((a) => a.startsWith('@ifc-lite/mcp'));
      // A bare package name runs whatever npm has, which may predate a flag.
      expect(pkg).toMatch(/^@ifc-lite\/mcp@\^\d+\.\d+\.\d+$/);
      const flags = server.args.slice(server.args.indexOf(pkg!) + 1);
      expect(parseArgs(flags).warnings).toEqual([]);
    }
  });
});
