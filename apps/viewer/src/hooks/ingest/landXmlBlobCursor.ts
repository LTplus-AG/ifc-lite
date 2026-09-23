/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounded Blob-to-WASM LandXML cursor driver. */

import { LandXmlStreamDocumentAssembler, LandXmlSurfaceFragmentAssembler, type LandXmlAssembledSurface } from './landXmlStreamAssembler.js';
import { readLandXmlSourceDocument } from './landXmlWasm.js';
import type { LandXmlTinDocument } from './landXmlSemantics.js';

export const LANDXML_BLOB_CHUNK_BYTES = 256 * 1024;
export const LANDXML_CURSOR_CREDIT_BYTES = 512 * 1024;
const MAX_WASM_U32 = 0xffff_ffff;

export interface LandXmlBlobCursorOptions {
  isCurrent?(): boolean;
  onProgress?(loadedBytes: number, totalBytes: number): void;
  onHeader?(header: unknown): void | Promise<void>;
  onSurface?(surface: LandXmlAssembledSurface): void | Promise<void>;
  /** Receives the original credited WASM event without source-document assembly. */
  onEvent?(event: unknown): void | Promise<void>;
  /**
   * #5175: opt-in linear unit for a source that declares no `<Units>`. A
   * declared `<Units>` always wins and pushes a warning; an unknown token
   * refuses rather than defaulting to meters. Forwarded verbatim to
   * `LandXmlCursorApi.createLandXmlTinStreamSession`'s parse options.
   */
  assumedLinearUnit?: string;
}

async function processStreamingEvents(
  value: unknown,
  surface: LandXmlSurfaceFragmentAssembler,
  onSurface: ((surface: LandXmlAssembledSurface) => void | Promise<void>) | undefined,
  onHeader: ((header: unknown) => void | Promise<void>) | undefined,
  onEvent: ((event: unknown) => void | Promise<void>) | undefined,
): Promise<void> {
  if (!Array.isArray(value)) throw new Error('LandXML cursor returned an invalid drain result');
  for (const event of value) {
    if (typeof event !== 'object' || event === null) throw new Error('LandXML cursor emitted an invalid stream event');
    const kind = (event as { kind?: unknown }).kind;
    if (kind === 'header') await onHeader?.(event);
    if (kind === 'surface') {
      const source = event as Record<string, unknown>;
      const complete = surface.push({
        source_id: String(source.source_id), component: String(source.component) as import('./landXmlStreamAssembler.js').LandXmlSurfaceStreamComponent,
        sequence: typeof source.sequence === 'number' ? source.sequence : Number.NaN,
        continued: source.continued === true, payload_utf8: source.payload_utf8,
      });
      if (complete !== null) await onSurface?.(complete);
    }
    await onEvent?.(event);
  }
}

/**
 * Feed the cursor without constructing a second semantic document in this
 * realm. Consumers receive only credited wire events and individual completed
 * surfaces; a main-thread owner may retain the final model exactly once.
 */
export async function streamLandXmlSourceBlobWithApi(
  api: LandXmlCursorApi,
  blob: Blob,
  options: LandXmlBlobCursorOptions = {},
): Promise<void> {
  if (!Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > MAX_WASM_U32) {
    throw new Error('LandXML source size is outside the WASM cursor limit');
  }
  const session = api.createLandXmlTinStreamSession(
    blob.size,
    options.assumedLinearUnit === undefined ? undefined : { assumedLinearUnit: options.assumedLinearUnit },
  );
  const surface = new LandXmlSurfaceFragmentAssembler();
  const drain = async (): Promise<void> => {
    await processStreamingEvents(session.drain(LANDXML_CURSOR_CREDIT_BYTES), surface, options.onSurface, options.onHeader, options.onEvent);
  };
  try {
    for (let offset = 0; offset < blob.size; offset += LANDXML_BLOB_CHUNK_BYTES) {
      ensureCurrent(options.isCurrent);
      const end = Math.min(blob.size, offset + LANDXML_BLOB_CHUNK_BYTES);
      const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      ensureCurrent(options.isCurrent);
      session.advanceChunk(bytes);
      while (session.outputPending()) await drain();
      options.onProgress?.(end, blob.size);
    }
    ensureCurrent(options.isCurrent);
    session.finishCursor();
    while (session.outputPending()) await drain();
    ensureCurrent(options.isCurrent);
    if (surface.hasPendingSurface) throw new Error('LandXML cursor ended with an incomplete surface');
  } finally {
    surface.abort();
    session.abort();
    session.free();
  }
}

export interface LandXmlCursorSession {
  advanceChunk(data: Uint8Array): void;
  drain(maxBytes: number): unknown;
  finishCursor(): void;
  outputPending(): boolean;
  abort(): void;
  free(): void;
}

export interface LandXmlCursorApi {
  createLandXmlTinStreamSession(
    maxBytes: number,
    options?: { assumedLinearUnit?: string } | null,
  ): LandXmlCursorSession;
}

function ensureCurrent(isCurrent: (() => boolean) | undefined): void {
  if (isCurrent && !isCurrent()) throw new Error('LandXML parsing cancelled');
}

async function processEvents(
  value: unknown,
  assembler: LandXmlStreamDocumentAssembler,
  onSurface: ((surface: LandXmlAssembledSurface) => void | Promise<void>) | undefined,
  onHeader: ((header: unknown) => void | Promise<void>) | undefined,
): Promise<LandXmlTinDocument | null> {
  if (!Array.isArray(value)) throw new Error('LandXML cursor returned an invalid drain result');
  let document: LandXmlTinDocument | null = null;
  for (const event of value) {
    if (typeof event === 'object' && event !== null && (event as { kind?: unknown }).kind === 'header') await onHeader?.(event);
    const result = assembler.push(event);
    if (result.surface !== null) await onSurface?.(result.surface);
    if (result.document !== null) document = readLandXmlSourceDocument(result.document);
  }
  return document;
}

/**
 * Feed Blob slices directly to the credited WASM cursor. The only input buffer
 * retained at once is one 256 KiB Blob slice; Rust refuses more input until the
 * 512 KiB credited transport queue has been drained.
 */
export async function parseLandXmlSourceBlobWithApi(
  api: LandXmlCursorApi,
  blob: Blob,
  options: LandXmlBlobCursorOptions = {},
): Promise<LandXmlTinDocument> {
  if (!Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > MAX_WASM_U32) {
    throw new Error('LandXML source size is outside the WASM cursor limit');
  }
  // Same option forwarding as `streamLandXmlSourceBlobWithApi` above. Both
  // entry points construct their own session, so an override honoured by only
  // one of them is an override a caller of the other silently cannot use
  // (#5175 review).
  const session = api.createLandXmlTinStreamSession(
    blob.size,
    options.assumedLinearUnit === undefined ? undefined : { assumedLinearUnit: options.assumedLinearUnit },
  );
  const assembler = new LandXmlStreamDocumentAssembler();
  let document: LandXmlTinDocument | null = null;
  const drain = async (): Promise<void> => {
    const completed = await processEvents(session.drain(LANDXML_CURSOR_CREDIT_BYTES), assembler, options.onSurface, options.onHeader);
    if (completed !== null) document = completed;
  };
  try {
    for (let offset = 0; offset < blob.size; offset += LANDXML_BLOB_CHUNK_BYTES) {
      ensureCurrent(options.isCurrent);
      const end = Math.min(blob.size, offset + LANDXML_BLOB_CHUNK_BYTES);
      const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      ensureCurrent(options.isCurrent);
      session.advanceChunk(bytes);
      while (session.outputPending()) await drain();
      options.onProgress?.(end, blob.size);
    }
    ensureCurrent(options.isCurrent);
    session.finishCursor();
    while (session.outputPending()) await drain();
    ensureCurrent(options.isCurrent);
    if (document === null) throw new Error('LandXML cursor ended without metadata document');
    return document;
  } finally {
    assembler.abort();
    session.abort();
    session.free();
  }
}
