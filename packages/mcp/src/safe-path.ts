/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Safe path resolution for LLM-supplied file paths.
 *
 * Every tool that reads from or writes to a path passed in by the LLM should
 * route through `resolveSafePath`. The helper:
 *
 *   1. Verifies the resolved absolute path falls inside an allowed root.
 *      - When the operator passed `--allow <dir>` flags, those are the only
 *        roots. This is the strict mode for production deployments.
 *      - Otherwise a "sensible workspace" default is used: the directories
 *        of currently-loaded models, the operator's working directory, and
 *        `os.tmpdir()`. This keeps the OOTB experience usable without
 *        defaulting to the whole filesystem.
 *   2. Follows symlinks (via realpath) and re-checks the canonical target
 *      against the allowlist — a link sitting in an allowed directory
 *      cannot redirect to arbitrary locations.
 *   3. Refuses paths that land in a small fixed list of sensitive
 *      $HOME subdirectories (credentials stores), regardless of how the
 *      allowlist is configured.
 */

import { realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import type { ModelRegistry, ServerConfig } from './context.js';
import { ToolErrorCode, ToolExecutionError } from './errors.js';

interface PathContext {
  config: Pick<ServerConfig, 'allowedPaths'>;
  registry: Pick<ModelRegistry, 'list'>;
}

/**
 * Top-level entries under $HOME we always refuse, even when other guards
 * would allow them. Credentials and key material live here; legitimate tool
 * workflows almost never need to touch them.
 */
const SENSITIVE_HOME_ENTRIES = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.gpg',
  '.kube',
  '.docker',
  '.gcloud',
  '.azure',
  '.npmrc',
  '.netrc',
  '.pgpass',
]);

export type PathMode = 'read' | 'write';

/**
 * Validate and canonicalise a path supplied by an MCP tool caller.
 *
 * - `mode === 'read'`: the file must exist; its realpath must land in an
 *   allowed root.
 * - `mode === 'write'`: the file may not exist yet. The realpath of the
 *   closest existing ancestor is used for the bounds check, then the missing
 *   tail is reattached.
 */
export async function resolveSafePath(
  raw: unknown,
  ctx: PathContext,
  mode: PathMode,
): Promise<string> {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ToolExecutionError({
      code: ToolErrorCode.INVALID_INPUT,
      message: 'file_path must be a non-empty string',
    });
  }
  const requested = resolve(raw);
  const roots = await buildAllowedRoots(ctx);
  rejectIfSensitiveHome(requested);
  ensureWithinRoots(requested, roots);
  const canonical = await canonicalise(requested, mode);
  rejectIfSensitiveHome(canonical);
  ensureWithinRoots(canonical, roots);
  return canonical;
}

async function buildAllowedRoots(ctx: PathContext): Promise<string[]> {
  const raw = new Set<string>();
  for (const p of ctx.config.allowedPaths ?? []) {
    raw.add(resolve(p));
  }
  if (raw.size === 0) {
    for (const m of ctx.registry.list()) {
      if (m.filePath) raw.add(dirname(m.filePath));
    }
    raw.add(resolve(process.cwd()));
    raw.add(resolve(tmpdir()));
  }
  // Include both the configured form and its realpath. The bounds check
  // runs first against the requested path (configured form) and then
  // against its realpath (canonical form); covering both shapes here
  // ensures a symlinked root (e.g. --allow /workspace where /workspace is
  // itself a symlink) still accepts files that legitimately live inside.
  const roots = new Set<string>(raw);
  for (const root of raw) {
    try {
      roots.add(await realpath(root));
    } catch {
      /* root does not yet exist on disk; the configured form stays in. */
    }
  }
  return [...roots];
}

function ensureWithinRoots(absolute: string, roots: string[]): void {
  if (roots.length === 0) {
    throw new ToolExecutionError({
      code: ToolErrorCode.PERMISSION_DENIED,
      message:
        'No allowed roots configured; pass --allow <dir> or load a model first.',
    });
  }
  const ok = roots.some(
    (root) => absolute === root || absolute.startsWith(root + sep),
  );
  if (!ok) {
    throw new ToolExecutionError({
      code: ToolErrorCode.PERMISSION_DENIED,
      message: `Path '${absolute}' is outside allowed roots`,
      details: { roots },
    });
  }
}

function rejectIfSensitiveHome(absolute: string): void {
  const home = resolve(homedir());
  if (absolute !== home && !absolute.startsWith(home + sep)) return;
  const rest = absolute === home ? '' : absolute.slice(home.length + 1);
  if (rest.length === 0) return;
  const first = rest.split(sep)[0];
  if (first && SENSITIVE_HOME_ENTRIES.has(first)) {
    throw new ToolExecutionError({
      code: ToolErrorCode.PERMISSION_DENIED,
      message: `Refusing to access '${absolute}': sensitive home entry '${first}'`,
    });
  }
}

async function canonicalise(p: string, mode: PathMode): Promise<string> {
  try {
    return await realpath(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (mode === 'read') {
    throw new ToolExecutionError({
      code: ToolErrorCode.INVALID_INPUT,
      message: `Path '${p}' does not exist`,
    });
  }
  // Write target: walk up until we find an existing ancestor, realpath it,
  // then reattach the missing tail. This catches symlinks anywhere along
  // the existing portion of the path. We use basename() for each segment
  // so the logic stays correct when an ancestor is the filesystem root
  // (where slice-by-length arithmetic would be off by one).
  let cursor = dirname(p);
  const tail: string[] = [basename(p)];
  while (true) {
    try {
      const real = await realpath(cursor);
      return resolve(real, ...tail);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `Path '${p}' has no existing ancestor`,
      });
    }
    tail.unshift(basename(cursor));
    cursor = parent;
  }
}
