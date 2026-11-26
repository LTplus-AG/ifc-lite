/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure helpers behind `./cli-main.ts`. Internal: not a package subpath, so
 * tests can reach them without making them public API.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliOptions } from './cli-args.js';
import { fullScope, readOnlyScope, type AuthScope } from './auth/scope.js';

/** Where Claude Desktop reads its MCP config on `platform`. */
export function claudeDesktopConfigPath(platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return '%APPDATA%\\Claude\\claude_desktop_config.json';
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

/** The server's scope when no token narrows it. */
export function serverScope(opts: CliOptions): AuthScope {
  return opts.readOnly ? readOnlyScope() : fullScope();
}

/**
 * The scope of an HTTP caller when no token is configured: the server's
 * scope without `admin`. `admin` passes every scope check, including any
 * scope added later, so it needs a `--token` that grants it; an anonymous
 * client of an open port is not that.
 */
export function anonymousHttpScope(opts: CliOptions): AuthScope {
  const scope = serverScope(opts);
  return { ...scope, scopes: scope.scopes.filter((s) => s !== 'admin') };
}

/**
 * The bearer tokens `opts` registers, each with its scope. `--token` gets
 * the server's scope; `--read-only-token` gets read scope. A token given
 * under both flags keeps the narrower scope.
 *
 * Each token gets its own `user` (`token-1`, `token-2`, …, in argv order).
 * The HTTP transport binds a session to its scope by content, so without
 * one, two tokens with equal scopes could use each other's sessions.
 */
export function tokenScopes(opts: CliOptions): Map<string, AuthScope> {
  const tokens = new Map<string, AuthScope>();
  for (const t of opts.tokens) tokens.set(t, serverScope(opts));
  for (const t of opts.readOnlyTokens) tokens.set(t, readOnlyScope());
  let n = 0;
  for (const scope of tokens.values()) scope.user = `token-${++n}`;
  return tokens;
}
