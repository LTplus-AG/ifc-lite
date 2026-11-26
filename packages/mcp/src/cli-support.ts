/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Helpers behind `./cli-main.ts`. Internal: not a package subpath, so
 * tests can reach them without making them public API.
 */

import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { CliOptions } from './cli-args.js';
import type { ModelRegistry } from './context.js';
import { deriveModelId, freeModelId, loadIfcModel } from './loader.js';
import { fmtInt } from './tools/util.js';
import { ToolErrorCode } from './errors.js';
import { resolveSafePath } from './safe-path.js';
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
 * Each token gets its own `session`, a random id for this process. The
 * HTTP transport binds a session to its scope by content, so without one,
 * two tokens with equal scopes could use each other's sessions. It is not
 * a `user`: the user is the principal of durable state (the BCF publication
 * journal, layer authorship), and nothing here can name one that is stable
 * across restarts without either reusing argv order (another token would
 * inherit it) or writing a hash of the secret into shared files.
 */
export function tokenScopes(opts: CliOptions): Map<string, AuthScope> {
  const tokens = new Map<string, AuthScope>();
  for (const t of opts.tokens) tokens.set(t, serverScope(opts));
  for (const t of opts.readOnlyTokens) tokens.set(t, readOnlyScope());
  for (const scope of tokens.values()) scope.session = `token-${randomUUID()}`;
  return tokens;
}

/**
 * Load one command-line file. With --allow it goes through the same policy as
 * `model_load` (real paths, both spellings of each root, protected home
 * entries); without, the operator's own arguments load from anywhere.
 */
async function loadAllowed(registry: ModelRegistry, opts: CliOptions, absolute: string, modelId: string) {
  // The check only: the model keeps the path the operator typed (name, filePath), as without --allow.
  if (opts.allowedPaths?.length) await resolveSafePath(absolute, { config: { allowedPaths: opts.allowedPaths }, registry }, 'read');
  return loadIfcModel(absolute, { modelId });
}

const PRINTABLE_ERRNO = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG']);

/**
 * A reason from a fixed list, never the error's text (which may spell the
 * path). resolveSafePath reports a missing file as INVALID_INPUT and its
 * three refusals as PERMISSION_DENIED; `details.roots` marks the bounds one.
 */
function loadFailureReason(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown; details?: { roots?: unknown } } | undefined;
  if (typeof e?.code === 'string' && PRINTABLE_ERRNO.has(e.code)) return e.code;
  const message = typeof e?.message === 'string' ? e.message : '';
  if (e?.code === ToolErrorCode.INVALID_INPUT && message.endsWith('does not exist')) return 'ENOENT';
  if (e?.code === ToolErrorCode.PERMISSION_DENIED) {
    if (e.details?.roots !== undefined) return 'outside --allow';
    if (message.startsWith('Refusing to access')) return 'protected home path';
    return 'EACCES';
  }
  return 'not a readable IFC file';
}

export async function loadFiles(registry: ModelRegistry, opts: CliOptions, log: (line: string) => void): Promise<void> {
  const seen = new Map<string, number>();
  for (const [index, file] of opts.files.entries()) {
    const label = `file argument ${index + 1} of ${opts.files.length}`;
    const absolute = resolve(file);
    // The real path, so ./m.ifc, M.ifc on a case-insensitive disk and a
    // symlink all count as one file. A path that does not resolve falls
    // through to the loader, which reports it.
    const key = await realpath(absolute).catch(() => absolute);
    const first = seen.get(key);
    if (first !== undefined) {
      log(`warning: ${label} repeats file argument ${first + 1}; skipped`);
      continue;
    }
    seen.set(key, index);
    // `arch/model.ifc` and `struct/model.ifc` both derive `model`; suffix the
    // later one so it cannot replace (and dispose) the earlier.
    const modelId = freeModelId(registry, deriveModelId(basename(file)));
    const m = await loadAllowed(registry, opts, absolute, modelId).catch((err: unknown) => {
      // Name the argument by position and give a fixed reason, never the
      // loader's text: a mistyped value flag (`--tokn secret`) leaves its
      // value here, any message may spell the path, and stderr reaches client logs.
      throw new Error(`${label} could not be loaded (${loadFailureReason(err)}). Check the path, and that no flag is misspelled.`);
    });
    registry.add(m);
    log(`loaded ${m.name} (${m.id}) — ${fmtInt(m.store.entityCount)} entities`);
    for (const w of m.scanWarnings ?? []) log(`warning: ${m.name}: ${w}`);
  }
}
