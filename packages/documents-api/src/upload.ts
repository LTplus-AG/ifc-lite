/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Uploading a single multipart-upload part per a server's `UploadFilePartInstruction`. */

import { FoundationApiError } from '@ifc-lite/opencde-foundation';
import type { FetchLike, FoundationTokenProvider } from '@ifc-lite/opencde-foundation';
import type { UploadFilePartInstruction } from './types.js';

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Build the request body for one upload part: the server's `content_range_start`
 * / `content_range_end` (inclusive, zero-based) select the slice of `fileBytes`
 * this part carries, and when the instruction carries `multipart_form_data`
 * the slice is wrapped with the server-supplied `prefix`/`suffix` bytes — the
 * Documents API spec's way of letting a server ask for a
 * `multipart/form-data` body without the client having to know its boundary
 * scheme.
 */
export function buildUploadPartBody(
  instruction: UploadFilePartInstruction,
  fileBytes: Uint8Array,
): Uint8Array {
  const slice = fileBytes.slice(
    instruction.content_range_start,
    instruction.content_range_end + 1,
  );
  if (!instruction.multipart_form_data) return slice;
  return concatBytes([
    base64ToBytes(instruction.multipart_form_data.prefix),
    slice,
    base64ToBytes(instruction.multipart_form_data.suffix),
  ]);
}

export interface UploadFilePartOptions {
  fetchFn: FetchLike;
  getAccessToken?: FoundationTokenProvider;
}

/**
 * Upload one part of a file per its `UploadFilePartInstruction`: PUT or POST
 * (as the server directs) to `instruction.url`, with the server's
 * `additional_headers` and, only when `include_authorization` is set (some
 * cloud storage providers reject the request otherwise), a Bearer token.
 */
export async function uploadFilePart(
  instruction: UploadFilePartInstruction,
  fileBytes: Uint8Array,
  options: UploadFilePartOptions,
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const header of instruction.additional_headers?.values ?? []) {
    headers[header.name] = header.value;
  }
  if (instruction.include_authorization) {
    const token = await options.getAccessToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const body = buildUploadPartBody(instruction, fileBytes);
  const response = await options.fetchFn(instruction.url, {
    method: instruction.http_method,
    headers,
    // TS's DOM lib types a typed array's own `.buffer` generic parameter
    // more strictly than `BodyInit` accepts; the runtime value is exactly
    // what `fetch` expects (an ArrayBufferView).
    body: body as BodyInit,
  });
  if (!response.ok) {
    throw new FoundationApiError(
      `Documents upload part failed (HTTP ${response.status}) at ${instruction.url}`,
      { status: response.status, url: instruction.url },
    );
  }
}
