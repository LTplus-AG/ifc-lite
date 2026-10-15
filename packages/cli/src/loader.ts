/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC file loader — reads and parses IFC files for CLI commands.
 */

import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';
import { basename } from 'node:path';
import { IfcParser, IfcInputError, validateStepInput, type IfcDataStore } from '@ifc-lite/parser';
import { createBimContext, type BimContext, type ViewerBackendMethods, type VisibilityBackendMethods } from '@ifc-lite/sdk';
import { HeadlessBackend } from './headless-backend.js';
import { createStreamingViewerAdapter, createStreamingVisibilityAdapter } from './streaming-viewer.js';

/**
 * Parse an IFC file from disk into an IfcDataStore.
 * Suppresses parser console output for clean CLI experience.
 */
export async function loadIfcFile(filePath: string): Promise<IfcDataStore> {
  const buffer = await readFile(filePath);
  return loadIfcBytes(buffer, filePath);
}

/**
 * Parse IFC bytes ALREADY in memory into an IfcDataStore — same validation and
 * console-capture as {@link loadIfcFile}, but without a disk read. Lets callers
 * that already hold the file buffer (e.g. `diagnose-geometry`, which read the
 * bytes once for the geometry pass) resolve GlobalId→expressId without a second
 * `readFile` of the same file. `label` is only used in error messages.
 */
export async function loadIfcBytes(
  bytes: Uint8Array,
  label = 'input',
): Promise<IfcDataStore> {
  try {
    return await parseIfcBytes(bytes, label);
  } catch (err) {
    if (!(err instanceof IfcBytesRejectedError)) throw err;
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

/** Bytes {@link parseIfcBytes} refused before parsing: empty, not STEP, truncated, or with no DATA section. */
/** The `scan:` diagnostics each loaded store was parsed with (#7610). */
const incompleteScans = new WeakMap<IfcDataStore, readonly string[]>();

/**
 * The scan diagnostics `store` was loaded with: empty when every record the
 * file declares was read, otherwise the lines already warned on stderr. Lets
 * a command explain an answer the missing records change, such as an id that
 * is "not found" because the scan refused its record.
 */
export function scanCompletenessWarnings(store: IfcDataStore): readonly string[] {
  return incompleteScans.get(store) ?? [];
}

export class IfcBytesRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IfcBytesRejectedError';
  }
}

/**
 * {@link loadIfcBytes} for a caller that must survive a bad file (a flow's
 * `model.openFromSource` mid-run): the same checks, but a rejection throws
 * {@link IfcBytesRejectedError} instead of exiting the process.
 */
export async function parseIfcBytes(
  bytes: Uint8Array,
  label = 'input',
): Promise<IfcDataStore> {
  try {
    bytes = await validateStepInput(bytes, label);
  } catch (error) {
    if (!(error instanceof IfcInputError)) throw error;
    throw new IfcBytesRejectedError(error.message);
  }

  const parser = new IfcParser();

  // Capture the parser's internal console.log/warn during parsing and route
  // them to logger.debug: silent by default (stdout stays clean for payloads),
  // visible on stderr under --verbose/--debug. The console capture is the
  // belt-and-suspenders for raw console lines the parser emits outside its
  // onDiagnostic channel.
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...parts: unknown[]) => {
    logger.debug(`parser: ${parts.map(String).join(' ')}`);
  };
  console.warn = (...parts: unknown[]) => {
    logger.debug(`parser: ${parts.map(String).join(' ')}`);
  };
  try {
    // Ensure we pass the exact slice — Node Buffers / Uint8Array views may be
    // windows into a larger pooled ArrayBuffer, so `.buffer` can include extra
    // bytes.
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const scanWarnings: string[] = [];
    const store = await parser.parseColumnar(arrayBuffer, {
      // The structured diagnostic channel, captured directly. A `scan:` line
      // says the model is SHORT: records were dropped (#3695, #7541) or
      // skipped (#3395). Like the truncation check above, that is not debug
      // detail: every command would otherwise answer, and `mutate`/`export`
      // write, from a model missing records with nothing said (#7610). So
      // those go to stderr at warn level, which keeps stdout clean for
      // payloads; the rest stays debug.
      onDiagnostic: (m: string) => {
        if (!m.startsWith('scan: ')) return logger.debug(`parser: ${m}`);
        scanWarnings.push(m);
        logger.warn(`Warning: ${label}: ${m}`);
      },
    });
    store.fileSize = bytes.byteLength;
    if (scanWarnings.length > 0) incompleteScans.set(store, scanWarnings);
    return store;
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

/**
 * Create a BimContext backed by a headless backend from an IFC file.
 */
export async function createHeadlessContext(filePath: string): Promise<{ bim: BimContext; store: IfcDataStore; backend: HeadlessBackend }> {
  const store = await loadIfcFile(filePath);
  const backend = new HeadlessBackend(store, basename(filePath));
  const bim = createBimContext({ backend });
  return { bim, store, backend };
}

/**
 * Create a BimContext that streams viewer commands to a running `ifc-lite view` server.
 *
 * SDK calls like `bim.viewer.colorize(...)` and `bim.viewer.isolate(...)` are
 * forwarded to the viewer via its REST API, updating the 3D view in real time.
 */
export async function createStreamingContext(
  filePath: string,
  viewerPort: number,
): Promise<{ bim: BimContext; store: IfcDataStore }> {
  const store = await loadIfcFile(filePath);
  const backend = new HeadlessBackend(store, basename(filePath));

  // Replace the no-op viewer/visibility adapters with streaming ones
  (backend as unknown as { viewer: ViewerBackendMethods }).viewer = createStreamingViewerAdapter(viewerPort);
  (backend as unknown as { visibility: VisibilityBackendMethods }).visibility = createStreamingVisibilityAdapter(viewerPort);

  const bim = createBimContext({ backend });
  return { bim, store };
}
