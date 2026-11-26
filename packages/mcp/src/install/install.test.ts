/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite-mcp install`: the config each client gets, and that an existing
 * config keeps every other server. Most cases run against an in-memory file
 * system on a chosen OS; the last one writes real files in a temp dir.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, symlinkSync, lstatSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall } from './run.js';
import { nodeInstallIo, type InstallIo } from './io.js';
import { InstallError, type HostEnv } from './clients.js';

const VERSION = '0.32.0';
const PKG = `@ifc-lite/mcp@^${VERSION}`;

interface Fake extends InstallIo {
  files: Map<string, string>;
  runs: Array<{ command: string; args: string[]; quiet?: boolean }>;
  stdout: string;
  stderr: string;
}

/** `statuses`: exit status of each run in turn (default 0). */
function fakeIo(host: Partial<HostEnv> = {}, opts: { missing?: boolean; statuses?: number[] } = {}): Fake {
  const io: Fake = {
    host: { platform: 'darwin', home: '/Users/u', cwd: '/work/proj', env: {}, listDir: () => [], ...host },
    files: new Map(),
    runs: [],
    stdout: '',
    stderr: '',
    readFile: (p) => io.files.get(p),
    writeFile: (p, t) => void io.files.set(p, t),
    copyFile: (from, to) => void io.files.set(to, io.files.get(from) ?? ''),
    run(command, args, quiet) {
      io.runs.push(quiet ? { command, args, quiet } : { command, args });
      return opts.missing ? { status: 127, missing: true } : { status: opts.statuses?.[io.runs.length - 1] ?? 0 };
    },
    out: (t) => void (io.stdout += t),
    err: (t) => void (io.stderr += t),
    now: () => new Date('2026-11-26T10:20:30Z'),
  };
  return io;
}

const install = (argv: string[], io: InstallIo) => runInstall(argv, io, 'ifc-lite-mcp install', VERSION);

describe('ifc-lite-mcp install: where each client is configured', () => {
  it.each([
    ['darwin', {}, '/Users/u/Library/Application Support/Claude/claude_desktop_config.json'],
    ['win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude_desktop_config.json'],
    ['linux', {}, '/Users/u/.config/Claude/claude_desktop_config.json'],
  ] as const)('Claude Desktop on %s', (platform, env, path) => {
    const io = fakeIo({ platform, env, home: platform === 'win32' ? 'C:\\Users\\u' : '/Users/u' });
    expect(install(['--client', 'claude-desktop'], io)).toBe(0);
    expect(JSON.parse(io.files.get(path) ?? 'null')).toEqual({
      mcpServers: { 'ifc-lite': { command: 'npx', args: ['-y', PKG] } },
    });
  });

  it('Claude Desktop from the Microsoft Store reads its virtualized AppData', () => {
    const io = fakeIo({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      listDir: (p) => ({
        'C:\\Users\\u\\AppData\\Local\\Packages': ['Claude_stale', 'Microsoft.Foo_1', 'Claude_pzs8sxrjxfjjc'],
        'C:\\Users\\u\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude': ['config.json'],
      })[p] ?? [],
    });
    install(['--client', 'claude-desktop'], io);
    expect([...io.files.keys()]).toEqual([
      'C:\\Users\\u\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json',
    ]);
  });

  it('an empty XDG_CONFIG_HOME counts as unset', () => {
    const io = fakeIo({ platform: 'linux', env: { XDG_CONFIG_HOME: '' } });
    install(['--client', 'claude-desktop'], io);
    expect([...io.files.keys()]).toEqual(['/Users/u/.config/Claude/claude_desktop_config.json']);
  });

  it('Cursor user and project scope', () => {
    const io = fakeIo();
    install(['--client', 'cursor'], io);
    install(['--client', 'cursor', '--scope', 'project'], io);
    expect([...io.files.keys()]).toEqual(['/Users/u/.cursor/mcp.json', '/work/proj/.cursor/mcp.json']);
  });

  it('VS Code workspace file uses "servers" and type stdio', () => {
    const io = fakeIo();
    install(['--client', 'vscode', '--scope', 'project'], io);
    expect(JSON.parse(io.files.get('/work/proj/.vscode/mcp.json') ?? 'null')).toEqual({
      servers: { 'ifc-lite': { type: 'stdio', command: 'npx', args: ['-y', PKG] } },
    });
  });

  it('VS Code user scope goes through `code --add-mcp`', () => {
    const io = fakeIo();
    expect(install(['--client', 'vscode', '--', '--bridge'], io)).toBe(0);
    expect(io.runs).toEqual([{
      command: 'code',
      args: ['--add-mcp', JSON.stringify({ name: 'ifc-lite', type: 'stdio', command: 'npx', args: ['-y', PKG, '--bridge'] })],
    }]);
  });

  it('Claude Code goes through `claude mcp add` with the server after --', () => {
    const io = fakeIo();
    expect(install(['--client', 'claude-code', 'models/a.ifc', '--', '--read-only', '--allow', 'shared'], io)).toBe(0);
    expect(io.runs).toEqual([{
      command: 'claude',
      args: ['mcp', 'add', '--scope', 'user', 'ifc-lite', '--', 'npx', '-y', PKG,
        '/work/proj/models/a.ifc', '--read-only', '--allow', '/work/proj/shared'],
    }]);
  });

  it('accepts --transport stdio, which is what clients use anyway', () => {
    const io = fakeIo();
    expect(install(['--client', 'cursor', '--', '--transport', 'stdio'], io)).toBe(0);
  });

  it('Claude Code --force says the old entry is gone when the add then fails', () => {
    const io = fakeIo({}, { statuses: [0, 1] });
    expect(install(['--client', 'claude-code', '--force'], io)).toBe(1);
    expect(io.stderr).toContain('already removed');
    const none = fakeIo({}, { statuses: [1, 1] });
    install(['--client', 'claude-code', '--force'], none);
    expect(none.stderr).not.toContain('already removed');
  });

  it('a file-system error is reported, not thrown, and names the backup', () => {
    const io = fakeIo();
    io.files.set('/Users/u/.cursor/mcp.json', '{}');
    io.writeFile = () => { throw new InstallError('EACCES: permission denied'); };
    expect(install(['--client', 'cursor'], io)).toBe(1);
    expect(io.stderr).toMatch(/EACCES.*unchanged \(backup: .*bak-/);
  });

  it('Claude Code --force removes the old entry first', () => {
    const io = fakeIo();
    install(['--client', 'claude-code', '--force', '--scope', 'project'], io);
    expect(io.runs[0]).toEqual({ command: 'claude', args: ['mcp', 'remove', '--scope', 'project', 'ifc-lite'], quiet: true });
    expect(io.runs[1].args.slice(0, 5)).toEqual(['mcp', 'add', '--scope', 'project', 'ifc-lite']);
  });
});

describe('ifc-lite-mcp install: existing configs', () => {
  const path = '/Users/u/.cursor/mcp.json';
  const other = { mcpServers: { github: { command: 'gh-mcp', args: ['--x'] } }, theme: 'dark' };

  it('keeps other servers and keys, and backs the file up', () => {
    const io = fakeIo();
    const before = JSON.stringify(other);
    io.files.set(path, before);
    expect(install(['--client', 'cursor'], io)).toBe(0);
    const after = JSON.parse(io.files.get(path) ?? 'null');
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.github).toEqual(other.mcpServers.github);
    expect(after.mcpServers['ifc-lite'].args).toEqual(['-y', PKG]);
    expect(io.files.get(`${path}.bak-20261126-102030000`)).toBe(before);
  });

  it('--force keeps keys the user added to the entry, such as env', () => {
    const io = fakeIo();
    io.files.set(path, JSON.stringify({ mcpServers: { 'ifc-lite': { command: 'npx', args: ['old'], env: { T: '1' } } } }));
    expect(install(['--client', 'cursor', '--force'], io)).toBe(0);
    expect(JSON.parse(io.files.get(path) ?? 'null').mcpServers['ifc-lite']).toEqual({ command: 'npx', args: ['-y', PKG], env: { T: '1' } });
    expect(install(['--client', 'cursor'], io)).toBe(0);
    expect(io.stderr).toContain('already has');
  });

  it('refuses a different entry with the same name unless --force', () => {
    const io = fakeIo();
    const mine = JSON.stringify({ mcpServers: { 'ifc-lite': { command: 'node', args: ['mine.js'] } } });
    io.files.set(path, mine);
    expect(install(['--client', 'cursor'], io)).toBe(1);
    expect(io.files.get(path)).toBe(mine);
    expect(io.stderr).toContain('--force');
    expect(install(['--client', 'cursor', '--force'], io)).toBe(0);
    expect(JSON.parse(io.files.get(path) ?? 'null').mcpServers['ifc-lite'].command).toBe('npx');
  });

  it('an entry with the same content in another key order is unchanged', () => {
    const io = fakeIo();
    io.files.set(path, JSON.stringify({ mcpServers: { 'ifc-lite': { args: ['-y', PKG], command: 'npx' } } }));
    expect(install(['--client', 'cursor'], io)).toBe(0);
    expect(io.stderr).toContain('already has');
  });

  it('a name shared with an Object.prototype member is just a name', () => {
    const io = fakeIo();
    expect(install(['--client', 'cursor', '--name', 'constructor'], io)).toBe(0);
    expect(Object.keys(JSON.parse(io.files.get(path) ?? 'null').mcpServers)).toEqual(['constructor']);
  });

  it('a second run with the same entry changes nothing', () => {
    const io = fakeIo();
    install(['--client', 'cursor'], io);
    const files = io.files.size;
    expect(install(['--client', 'cursor'], io)).toBe(0);
    expect(io.files.size).toBe(files);
    expect(io.stderr).toContain('already has');
  });

  it('reads a file saved with a byte-order mark', () => {
    const io = fakeIo();
    io.files.set(path, `\uFEFF${JSON.stringify(other)}`);
    expect(install(['--client', 'cursor'], io)).toBe(0);
    expect(JSON.parse(io.files.get(path) ?? 'null').mcpServers.github).toEqual(other.mcpServers.github);
  });

  it('refuses a file with comments and prints the entry to add by hand', () => {
    const io = fakeIo();
    const jsonc = '{\n  // mine\n  "mcpServers": {}\n}\n';
    io.files.set(path, jsonc);
    expect(install(['--client', 'cursor'], io)).toBe(1);
    expect(io.files.get(path)).toBe(jsonc);
    expect(io.stderr).toContain('"ifc-lite"');
  });
});

describe('ifc-lite-mcp install: dry run and usage errors', () => {
  it('--dry-run prints only the new entry, never other servers, and writes nothing', () => {
    const io = fakeIo();
    const path = '/Users/u/Library/Application Support/Claude/claude_desktop_config.json';
    io.files.set(path, JSON.stringify({ mcpServers: { gh: { command: 'gh', env: { GITHUB_TOKEN: 'secret' } } } }));
    expect(install(['--client', 'claude-desktop', '--dry-run'], io)).toBe(0);
    expect(io.files.size).toBe(1);
    expect(io.stdout).not.toContain('secret');
    expect(JSON.parse(io.stdout)).toEqual({ mcpServers: { 'ifc-lite': { command: 'npx', args: ['-y', PKG] } } });
  });

  it('--scope project warns about model paths given after --', () => {
    const io = fakeIo();
    install(['--client', 'cursor', '--scope', 'project', '--', '--read-only', 'model.ifc'], io);
    expect(io.stderr).toContain('only work on this machine');
  });

  it('--dry-run for a CLI client prints the command, quoted', () => {
    const io = fakeIo({ cwd: '/My Models' });
    expect(install(['--client', 'claude-code', '--dry-run', 'a.ifc'], io)).toBe(0);
    expect(io.runs).toEqual([]);
    expect(io.stdout).toBe(`claude mcp add --scope user ifc-lite -- npx -y '${PKG}' '/My Models/a.ifc'\n`);
  });

  it('--dry-run --force prints the remove step a real run takes first', () => {
    const io = fakeIo();
    install(['--client', 'claude-code', '--dry-run', '--force'], io);
    expect(io.stdout.split('\n')[0]).toBe('claude mcp remove --scope user ifc-lite');
  });

  it('quotes the printed command for cmd.exe on Windows', () => {
    const io = fakeIo({ platform: 'win32', home: 'C:\\Users\\u', cwd: 'C:\\My Models' });
    install(['--client', 'vscode', '--dry-run', 'a.ifc'], io);
    const json = JSON.stringify({ name: 'ifc-lite', type: 'stdio', command: 'npx', args: ['-y', PKG, 'C:\\My Models\\a.ifc'] });
    expect(io.stdout).toBe(`code --add-mcp "${json.replace(/"/g, '""')}"\n`);
  });

  it('says --force has no effect for `code --add-mcp`', () => {
    const io = fakeIo();
    install(['--client', 'vscode', '--force'], io);
    expect(io.stderr).toContain('--force has no effect');
  });

  it('prints the command when the client CLI is not on PATH', () => {
    const io = fakeIo({}, { missing: true });
    expect(install(['--client', 'claude-code'], io)).toBe(1);
    expect(io.stderr).toContain(`claude mcp add --scope user ifc-lite -- npx -y '${PKG}'`);
  });

  it.each([
    [[], '--client is required'],
    [['--client', 'zed'], 'Unknown client'],
    [['--client', 'cursor', '--read-only'], 'Server flags go after --'],
    [['--client', 'cursor', '--', '--transport', 'http'], 'drop --transport'],
    [['--client', 'cursor', '--', '--transport'], 'drop --transport'],
    [['--client', 'cursor', '--', '--version'], 'print and exit'],
    [['--client', 'cursor', 'model.ifc', '--', '--bridge'], 'loads no files'],
    [['--client', 'cursor', '-v'], 'not an install option'],
    [['--client', 'cursor', '--', '--readonly'], 'no --readonly flag'],
    [['--client', 'cursor', '--', '--transport=http'], 'with a space'],
    [['--client', 'cursor', '--', '--allow=./models'], 'with a space'],
    [['--client=cursor'], 'Write --client <value>'],
    [['--client', 'cursor', '--', '--transport', 'stdio', '--transport', 'http'], 'drop --transport'],
    [['--client', 'claude-desktop', '--scope', 'project'], 'no project config'],
    [['--client', 'cursor', '--name', 'a b'], '--name'],
  ])('%j is refused', (argv, message) => {
    const io = fakeIo();
    expect(install(argv, io)).toBe(1);
    expect(io.stderr).toContain(message);
    expect(io.files.size).toBe(0);
  });
});

describe('ifc-lite-mcp install: real files', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('merges into an existing file on disk and leaves a backup beside it', () => {
    dir = mkdtempSync(join(tmpdir(), 'ifc-lite-install-'));
    mkdirSync(join(dir, '.cursor'));
    const path = join(dir, '.cursor', 'mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const io: InstallIo = { ...nodeInstallIo(), host: { platform: process.platform, home: dir, cwd: dir, env: {}, listDir: () => [] }, err: () => {} };
    expect(install(['--client', 'cursor'], io)).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf-8')).mcpServers)).toEqual(['other', 'ifc-lite']);
    expect(readdirSync(join(dir, '.cursor')).sort()).toEqual([
      'mcp.json',
      expect.stringMatching(/^mcp\.json\.bak-\d{8}-\d{9}$/),
    ]);
  });

  it('a real permission error is reported, not thrown', () => {
    dir = mkdtempSync(join(tmpdir(), 'ifc-lite-install-'));
    // A directory where the config file should be: reading it fails with EISDIR.
    mkdirSync(join(dir, '.cursor', 'mcp.json'), { recursive: true });
    let stderr = '';
    const io: InstallIo = { ...nodeInstallIo(), host: { platform: process.platform, home: dir, cwd: dir, env: {}, listDir: () => [] }, err: (t) => void (stderr += t) };
    expect(install(['--client', 'cursor'], io)).toBe(1);
    expect(stderr).toContain('EISDIR');
  });

  it.skipIf(process.platform === 'win32')('writes through a dangling dotfiles symlink', () => {
    dir = mkdtempSync(join(tmpdir(), 'ifc-lite-install-'));
    mkdirSync(join(dir, '.cursor'));
    const real = join(dir, 'dotfiles', 'cursor', 'mcp.json');
    symlinkSync(real, join(dir, '.cursor', 'mcp.json'));
    const io: InstallIo = { ...nodeInstallIo(), host: { platform: process.platform, home: dir, cwd: dir, env: {}, listDir: () => [] }, err: () => {} };
    expect(install(['--client', 'cursor'], io)).toBe(0);
    expect(lstatSync(join(dir, '.cursor', 'mcp.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf-8')).mcpServers['ifc-lite'].command).toBe('npx');
  });

  it.skipIf(process.platform === 'win32')('follows a chain of dangling links to its missing end', () => {
    dir = mkdtempSync(join(tmpdir(), 'ifc-lite-install-'));
    mkdirSync(join(dir, '.cursor'));
    mkdirSync(join(dir, 'dotfiles'));
    const real = join(dir, 'repo', 'mcp.json');
    symlinkSync(real, join(dir, 'dotfiles', 'cursor.json'));
    symlinkSync(join(dir, 'dotfiles', 'cursor.json'), join(dir, '.cursor', 'mcp.json'));
    const io: InstallIo = { ...nodeInstallIo(), host: { platform: process.platform, home: dir, cwd: dir, env: {}, listDir: () => [] }, err: () => {} };
    expect(install(['--client', 'cursor'], io)).toBe(0);
    expect(lstatSync(join(dir, 'dotfiles', 'cursor.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf-8')).mcpServers['ifc-lite'].command).toBe('npx');
  });

  it.skipIf(process.platform === 'win32')('writes through a symlinked config and keeps its mode', () => {
    dir = mkdtempSync(join(tmpdir(), 'ifc-lite-install-'));
    mkdirSync(join(dir, 'dotfiles'));
    mkdirSync(join(dir, '.cursor'));
    const real = join(dir, 'dotfiles', 'mcp.json');
    writeFileSync(real, '{}');
    chmodSync(real, 0o600);
    symlinkSync(real, join(dir, '.cursor', 'mcp.json'));
    const io: InstallIo = { ...nodeInstallIo(), host: { platform: process.platform, home: dir, cwd: dir, env: {}, listDir: () => [] }, err: () => {} };
    expect(install(['--client', 'cursor'], io)).toBe(0);
    expect(lstatSync(join(dir, '.cursor', 'mcp.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf-8')).mcpServers['ifc-lite'].command).toBe('npx');
    expect(statSync(real).mode & 0o777).toBe(0o600);
  });
});
