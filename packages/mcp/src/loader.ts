/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC file loader for the MCP server. Wraps `IfcParser.parseColumnar`,
 * mounts a `HeadlessLikeBackend` on top of the resulting `IfcDataStore`,
 * and produces a `LoadedModel` ready to drop into the registry.
 *
 * We don't pull in `@ifc-lite/cli`'s `HeadlessBackend` directly because that
 * package depends on `@ifc-lite/viewer-core` which is browser-shaped. Instead
 * we re-implement the small subset of `BimBackend` the MCP tools actually use
 * (model + query + selection + spatial + export + mutate). All the renderer
 * methods are no-ops, which is fine — agents never call them through MCP.
 */

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { IfcParser, validateStepInput, type IfcDataStore } from '@ifc-lite/parser';
import { sourceModelIdentity } from '@ifc-lite/cache';
import { createBimContext, type BimContext } from '@ifc-lite/sdk';
import type { LoadedModel } from './context.js';
import { HeadlessLikeBackend } from './headless-backend.js';

export interface LoadIfcOptions {
  /** Override the registered model ID (default = file basename without extension). */
  modelId?: string;
  /** Restrict reads to these absolute path prefixes. Used by the stdio CLI. */
  allowedPaths?: string[];
}

export async function loadIfcModel(filePath: string, opts: LoadIfcOptions = {}): Promise<LoadedModel> {
  const absolute = resolve(filePath);
  if (opts.allowedPaths && opts.allowedPaths.length > 0) {
    const ok = opts.allowedPaths.some((p) => absolute === p || absolute.startsWith(p + '/'));
    if (!ok) {
      throw new Error(`Path '${absolute}' is outside the allowed roots`);
    }
  }

  const buffer = await readFile(absolute);
  const loaded = await loadIfcModelFromBytes(buffer, basename(absolute), opts.modelId, absolute);
  return { ...loaded, filePath: absolute };
}

/**
 * Parse IFC bytes already in memory (a flow's `model.openFromSource`) into a
 * `LoadedModel` — the same unwrap, signature check and parser setup as
 * {@link loadIfcModel}, which reads the file and calls this. `label` names the
 * source in errors; it defaults to `name`.
 */
export async function loadIfcModelFromBytes(bytes: Uint8Array, name: string, modelId?: string, label = name): Promise<LoadedModel> {
  const buffer = Buffer.from(await validateStepInput(bytes, label));

  const parser = new IfcParser();
  // The parser writes progress to console.* — silence it during MCP loads
  // so the JSON-RPC channel on stdout isn't polluted.
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (): void => undefined;
  console.warn = (): void => undefined;
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
    console.log = origLog;
    console.warn = origWarn;
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

export function deriveModelId(name: string): string {
  // Strip extension, replace spaces with underscores, lowercase. Keeps the
  // ID URL-safe so it round-trips through `Mcp-Session-Id` headers and
  // resource URIs.
  return name
    .replace(/\.(ifc|ifcxml|ifczip)$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .toLowerCase() || 'model';
}
