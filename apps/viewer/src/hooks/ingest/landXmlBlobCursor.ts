/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounded Blob-to-WASM LandXML cursor driver. */

import { LandXmlStreamDocumentAssembler, type LandXmlAssembledSurface } from './landXmlStreamAssembler.js';
import { readLandXmlSourceDocument } from './landXmlWasm.js';
import type { LandXmlTinDocument } from './landXmlSemantics.js';

export const LANDXML_BLOB_CHUNK_BYTES = 256 * 1024;
export const LANDXML_CURSOR_CREDIT_BYTES = 512 * 1024;
const MAX_WASM_U32 = 0xffff_ffff;

export interface LandXmlBlobCursorOptions {
  isCurrent?(): boolean;
  onProgress?(loadedBytes: number, totalBytes: number): void;
  onSurface?(surface: LandXmlAssembledSurface): void;
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
  createLandXmlTinStreamSession(maxBytes: number): LandXmlCursorSession;
}

function ensureCurrent(isCurrent: (() => boolean) | undefined): void {
  if (isCurrent && !isCurrent()) throw new Error('LandXML parsing cancelled');
}

function processEvents(
  value: unknown,
  assembler: LandXmlStreamDocumentAssembler,
  onSurface: ((surface: LandXmlAssembledSurface) => void) | undefined,
): LandXmlTinDocument | null {
  if (!Array.isArray(value)) throw new Error('LandXML cursor returned an invalid drain result');
  let document: LandXmlTinDocument | null = null;
  for (const event of value) {
    const result = assembler.push(event);
    if (result.surface !== null) onSurface?.(result.surface);
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
  const session = api.createLandXmlTinStreamSession(blob.size);
  const assembler = new LandXmlStreamDocumentAssembler();
  let document: LandXmlTinDocument | null = null;
  const drain = (): void => {
    const completed = processEvents(session.drain(LANDXML_CURSOR_CREDIT_BYTES), assembler, options.onSurface);
    if (completed !== null) document = completed;
  };
  try {
    for (let offset = 0; offset < blob.size; offset += LANDXML_BLOB_CHUNK_BYTES) {
      ensureCurrent(options.isCurrent);
      const end = Math.min(blob.size, offset + LANDXML_BLOB_CHUNK_BYTES);
      const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      ensureCurrent(options.isCurrent);
      session.advanceChunk(bytes);
      while (session.outputPending()) drain();
      options.onProgress?.(end, blob.size);
    }
    ensureCurrent(options.isCurrent);
    session.finishCursor();
    while (session.outputPending()) drain();
    ensureCurrent(options.isCurrent);
    if (document === null) throw new Error('LandXML cursor ended without metadata document');
    return document;
  } finally {
    assembler.abort();
    session.abort();
    session.free();
  }
}
