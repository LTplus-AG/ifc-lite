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
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
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
  if (buffer.byteLength === 0) {
    throw new Error(`'${absolute}' is empty (0 bytes)`);
  }

  // Cheap signature check; full parser also bails on malformed STEP.
  const headerSnippet = buffer.subarray(0, Math.min(buffer.byteLength, 256)).toString('ascii');
  if (!headerSnippet.includes('ISO-10303-21')) {
    throw new Error(`'${absolute}' is not a valid IFC/STEP file`);
  }

  const parser = new IfcParser();
  // The parser writes progress to console.* — silence it during MCP loads
  // so the JSON-RPC channel on stdout isn't polluted.
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (): void => undefined;
  console.warn = (): void => undefined;
  let store: IfcDataStore;
  try {
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    store = await parser.parseColumnar(arrayBuffer);
    store.fileSize = buffer.byteLength;
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }

  const id = opts.modelId ?? deriveModelId(basename(absolute));
  const backend = new HeadlessLikeBackend(store, basename(absolute), id);
  const bim: BimContext = createBimContext({ backend });

  return {
    id,
    name: basename(absolute),
    bim,
    store,
    backend,
    filePath: absolute,
    loadedAt: Date.now(),
  };
}

function deriveModelId(name: string): string {
  // Strip extension, replace spaces with underscores, lowercase. Keeps the
  // ID URL-safe so it round-trips through `Mcp-Session-Id` headers and
  // resource URIs.
  return name
    .replace(/\.(ifc|ifcxml|ifczip)$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .toLowerCase() || 'model';
}
