/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC file loader for the MCP server. Wraps `IfcParser.parseColumnar`,
 * mounts a `HeadlessLikeBackend` on top of the resulting `IfcDataStore`,
 * and produces a `LoadedModel` ready to drop into the registry.
 *
 * The SDK owns the shared headless backend. This adapter supplies MCP's
 * native geometry preparation and registry/file-loading behavior.
 */

import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { IfcParser, validateStepInput, type IfcDataStore } from '@ifc-lite/parser';
import { sourceModelIdentity } from '@ifc-lite/cache';
import { createBimContext, type BimContext } from '@ifc-lite/sdk';
import type { LoadedModel, ModelRegistry } from './context.js';
import { HeadlessLikeBackend } from './headless-backend.js';
import { rememberLoadedSource } from './loaded-source.js';

export interface LoadIfcOptions {
  /** Override the registered model ID (default = file basename without extension). */
  modelId?: string;
  /** Restrict reads to these absolute path prefixes (model_load and the CLI pass the checked path itself). */
  allowedPaths?: string[];
}

/** Load IFC bytes and retain the opened file identity for source-write protection. */
export async function loadIfcModel(filePath: string, opts: LoadIfcOptions = {}): Promise<LoadedModel> {
  const absolute = resolve(filePath);
  const roots = (opts.allowedPaths ?? []).map(normalRoot);
  if (roots.length > 0) {
    const realRoots = await Promise.all(roots.map(realRoot));
    // Either spelling up front (a root given as /tmp/x admits /private/tmp/x)...
    if (!inRoots(absolute, roots) && !inRoots(absolute, realRoots)) throw outsideRoots(absolute);
    // ...but the real path decides: a symlink in the path, or one swapped in
    // since the caller checked it, must not lead outside the real roots.
    if (!inRoots(await realpath(absolute), realRoots)) throw outsideRoots(absolute);
  }
  const canonical = await realpath(absolute);
  // Refuse special files before opening them: opening a device can have side
  // effects, and a FIFO with no writer blocks. Then open without blocking and
  // without following a symlink swapped in since realpath, and check the
  // opened descriptor again in case the path changed in between.
  if (!(await stat(canonical)).isFile()) throw new Error(`Path '${absolute}' is not a regular file`);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  let buffer: Buffer;
  let identity: { path: string; dev: bigint; ino: bigint };
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new Error(`Path '${absolute}' is not a regular file`);
    identity = { path: canonical, dev: info.dev, ino: info.ino };
    buffer = await handle.readFile();
  } finally {
    await handle.close();
  }
  const loaded = await loadIfcModelFromBytes(buffer, basename(absolute), opts.modelId, absolute);
  const model = { ...loaded, filePath: absolute };
  rememberLoadedSource(model, identity);
  return model;
}

/**
 * Parse IFC bytes already in memory (a flow's `model.openFromSource`) into a
 * `LoadedModel` — the same unwrap, signature check and parser setup as
 * {@link loadIfcModel}, which reads the file and calls this. `label` names the
 * source in errors; it defaults to `name`.
 */
export async function loadIfcModelFromBytes(bytes: Uint8Array, name: string, modelId?: string, label = name): Promise<LoadedModel> {
  // Preserve this existing loader's recovery behavior; new parseModel sessions
  // validate complete envelopes. A partial scan still carries scanWarnings.
  const buffer = Buffer.from(await validateStepInput(bytes, label, { envelope: 'signature' }));

  const parser = new IfcParser();
  // The parser writes progress to console.* — silence it during MCP loads
  // so the JSON-RPC channel on stdout isn't polluted.
  const origLog = console.log;
  const origWarn = console.warn;
  const silent = (): void => undefined;
  console.log = silent;
  console.warn = silent;
  let store: IfcDataStore;
  // Kept, not silenced with the console: a `scan:` line says the model is
  // missing records, which the caller has to hear (#7610).
  const scanWarnings: string[] = [];
  try {
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    store = await parser.parseColumnar(arrayBuffer, {
      onDiagnostic: (m) => { if (m.startsWith('scan: ')) scanWarnings.push(m); },
    });
    store.fileSize = buffer.byteLength;
  } finally {
    // Restore only what is still ours: a stdio transport that connected
    // mid-load has re-pointed console.log at stderr, and that must stay.
    if (console.log === silent) console.log = origLog;
    if (console.warn === silent) console.warn = origWarn;
  }

  const id = modelId ?? deriveModelId(name);
  const backend = new HeadlessLikeBackend(store, name, id);
  const bim: BimContext = createBimContext({ backend });

  return {
    id,
    name,
    bim,
    store,
    backend,
    // Computed from the POST-unwrap bytes, so an .ifcZIP is fingerprinted by
    // the STEP it contains — the viewer's rule (#5138).
    sourceFingerprint: sourceModelIdentity(name, buffer),
    ...(scanWarnings.length > 0 ? { scanWarnings } : {}),
    loadedAt: Date.now(),
  };
}

/** `base`, or `base_2`, `base_3`, … — the first id the registry does not hold yet. */
export function freeModelId(registry: ModelRegistry, base: string): string {
  let id = base;
  for (let n = 2; registry.get(id) !== null; n += 1) id = `${base}_${n}`;
  return id;
}

/** Absolute, without a trailing separator unless it is a filesystem root (`/`, `C:\\`). */
function normalRoot(p: string): string {
  const r = resolve(p);
  return r !== parse(r).root && r.endsWith(sep) ? r.slice(0, -1) : r;
}

/**
 * A root's real form. A directory root is followed through links (macOS
 * /tmp -> /private/tmp). A root that is not a directory, such as the checked
 * file model_load and the CLI pass, keeps its last component: following it
 * would move the root along with a file swapped for a symlink. A root that
 * cannot be resolved stays as written, so it admits nothing it did not before.
 */
async function realRoot(root: string): Promise<string> {
  const real = await realpath(root).catch(() => root);
  if (real === root) return root;
  if ((await stat(real).catch(() => null))?.isDirectory()) return real;
  return join(await realpath(dirname(root)).catch(() => dirname(root)), basename(root));
}

function inRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((p) => path === p || path.startsWith(p.endsWith(sep) ? p : p + sep));
}

function outsideRoots(path: string): Error {
  return new Error(`Path '${path}' is outside the allowed roots`);
}

export function deriveModelId(name: string): string {
  // Strip extension, replace spaces with underscores, lowercase. Keeps the
  // ID URL-safe so it round-trips through `Mcp-Session-Id` headers and
  // resource URIs.
  return name
    .replace(/\.(ifc|ifcxml|ifczip)$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .toLowerCase() || 'model';
}
