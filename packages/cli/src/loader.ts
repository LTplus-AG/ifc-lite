/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC file loader — reads and parses IFC files for CLI commands.
 */

import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';
import { basename } from 'node:path';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
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
  // Validate the file is a STEP/IFC file
  if (bytes.byteLength === 0) {
    process.stderr.write(`Error: ${label} is empty (0 bytes)\n`);
    process.exit(1);
  }

  // Check for STEP file signature ("ISO-10303-21") in the first 256 bytes.
  // TextDecoder (not Buffer.toString) so a plain Uint8Array view works too.
  const headerSnippet = new TextDecoder('latin1').decode(
    bytes.subarray(0, Math.min(bytes.byteLength, 256)),
  );
  if (!headerSnippet.includes('ISO-10303-21')) {
    process.stderr.write(`Error: ${label} is not a valid IFC/STEP file\n`);
    process.exit(1);
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
    const store = await parser.parseColumnar(arrayBuffer, {
      // The structured diagnostic channel, captured directly.
      onDiagnostic: (m: string) => logger.debug(`parser: ${m}`),
    });
    store.fileSize = bytes.byteLength;
    return store;
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

/**
 * Create a BimContext backed by a headless backend from an IFC file.
 */
export async function createHeadlessContext(filePath: string): Promise<{ bim: BimContext; store: IfcDataStore }> {
  const store = await loadIfcFile(filePath);
  const backend = new HeadlessBackend(store, basename(filePath));
  const bim = createBimContext({ backend });
  return { bim, store };
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
