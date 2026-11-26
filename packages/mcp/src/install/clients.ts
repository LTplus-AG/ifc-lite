/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where each MCP client keeps its server list, and what an entry looks like.
 *
 * Sources (checked 2026-11-26):
 * - Claude Code: `claude mcp add [--scope local|project|user] <name> -- <cmd> [args]`
 *   (code.claude.com/docs/en/mcp).
 * - Claude Desktop: `claude_desktop_config.json`, key `mcpServers`, under
 *   `~/Library/Application Support/Claude` (macOS), `%APPDATA%\Claude` (Windows),
 *   `~/.config/Claude` (Linux) (modelcontextprotocol.io/docs/develop/connect-local-servers).
 * - Cursor: `~/.cursor/mcp.json` or `<project>/.cursor/mcp.json`, key `mcpServers`
 *   (cursor.com/docs/context/mcp).
 * - VS Code: `<workspace>/.vscode/mcp.json`, key `servers`, entries need
 *   `type: "stdio"`; the user profile is reached through `code --add-mcp <json>`
 *   (code.visualstudio.com/docs/agents/reference/mcp-configuration).
 */

import { posix, win32 } from 'node:path';

/** Every supported client and its display name. */
export const CLIENTS = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  vscode: 'VS Code',
} as const;
export type ClientId = keyof typeof CLIENTS;

/** `user`: every project of this user. `project`: the current directory only. */
export type InstallScope = 'user' | 'project';

/** The machine the config is written for. Injected so tests can be any OS. */
export interface HostEnv {
  platform: NodeJS.Platform;
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Entry names in a directory; [] when it does not exist. */
  listDir(path: string): string[];
}

/** The command a client spawns to start the server. */
export interface ServerCommand {
  command: string;
  args: string[];
}

export interface FilePlan {
  kind: 'file';
  path: string;
  key: 'mcpServers' | 'servers';
  entry: Record<string, unknown>;
}

export interface CommandPlan {
  kind: 'command';
  command: string;
  args: string[];
  /** Run first under --force, because the CLI refuses an existing name. */
  remove?: string[];
}

/** A client takes the server either as an entry in a JSON file or through its own CLI. */
export type InstallPlan = FilePlan | CommandPlan;

export class InstallError extends Error {}

export function isClientId(value: string): value is ClientId {
  return Object.hasOwn(CLIENTS, value);
}

export function planInstall(
  client: ClientId,
  scope: InstallScope,
  name: string,
  server: ServerCommand,
  host: HostEnv,
): InstallPlan {
  const path = host.platform === 'win32' ? win32 : posix;
  switch (client) {
    case 'claude-code':
      return {
        kind: 'command',
        command: 'claude',
        args: ['mcp', 'add', '--scope', scope, name, '--', server.command, ...server.args],
        remove: ['mcp', 'remove', '--scope', scope, name],
      };
    case 'claude-desktop':
      if (scope === 'project') throw new InstallError('Claude Desktop has no project config; drop --scope project.');
      return { kind: 'file', path: claudeDesktopConfigPath(host), key: 'mcpServers', entry: { ...server } };
    case 'cursor':
      return {
        kind: 'file',
        path: path.join(scope === 'user' ? host.home : host.cwd, '.cursor', 'mcp.json'),
        key: 'mcpServers',
        entry: { ...server },
      };
    case 'vscode': {
      const entry = { type: 'stdio', ...server };
      if (scope === 'project') {
        return { kind: 'file', path: path.join(host.cwd, '.vscode', 'mcp.json'), key: 'servers', entry };
      }
      return { kind: 'command', command: 'code', args: ['--add-mcp', JSON.stringify({ name, ...entry })] };
    }
  }
}

function claudeDesktopConfigPath(host: HostEnv): string {
  const file = 'claude_desktop_config.json';
  if (host.platform === 'darwin') {
    return posix.join(host.home, 'Library', 'Application Support', 'Claude', file);
  }
  if (host.platform === 'win32') {
    // The Microsoft Store (MSIX) build reads a virtualized AppData under its
    // package folder, which shadows %APPDATA%\Claude once the app has run.
    // `||`, not `??`: an empty variable counts as unset (XDG says so too).
    const localAppData = host.env.LOCALAPPDATA || win32.join(host.home, 'AppData', 'Local');
    const packages = win32.join(localAppData, 'Packages');
    const msix = host.listDir(packages).find((d) => d.startsWith('Claude_'));
    if (msix) return win32.join(packages, msix, 'LocalCache', 'Roaming', 'Claude', file);
    const appData = host.env.APPDATA || win32.join(host.home, 'AppData', 'Roaming');
    return win32.join(appData, 'Claude', file);
  }
  const config = host.env.XDG_CONFIG_HOME || posix.join(host.home, '.config');
  return posix.join(config, 'Claude', file);
}
