/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { OciError } from './errors.js';
import type { OciHasher } from './types.js';

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

async function webCryptoSha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new TypeError('@ifc-lite/oci: WebCrypto (globalThis.crypto.subtle) is unavailable; pass createHasher');
  }
  return toHex(await subtle.digest('SHA-256', bytes));
}

export interface ReadBodyOptions {
  /** Hard cap; the transfer is cancelled as soon as more bytes arrive. */
  cap: number;
  /**
   * When true the body must be exactly `cap` bytes, and the bytes are written
   * into one preallocated buffer (no chunk list, no concatenation copy).
   */
  exact?: boolean;
  /** Receives every chunk as it arrives (for a streaming hasher). */
  onChunk?: (chunk: Uint8Array) => void;
  /** Used in error messages. */
  what: string;
}

function tooLarge(what: string, cap: number): OciError {
  return new OciError('SIZE_EXCEEDED', `${what}: body exceeds the ${cap}-byte limit; transfer aborted`);
}

/**
 * Reads a response body under a hard size cap. A declared `Content-Length`
 * above the cap fails before any byte is read; otherwise the stream is
 * cancelled the moment the running total passes the cap, so an oversized or
 * endless body never lands in memory.
 */
export async function readBody(response: Response, options: ReadBodyOptions): Promise<Uint8Array<ArrayBuffer>> {
  const { cap, exact = false, onChunk, what } = options;
  const declared = response.headers.get('content-length');
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > cap) {
    await response.body?.cancel();
    throw tooLarge(what, cap);
  }
  const body = response.body;
  const target = exact ? new Uint8Array(cap) : undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > cap) {
        await reader.cancel();
        throw tooLarge(what, cap);
      }
      if (target) target.set(value, total);
      else chunks.push(value);
      total += value.byteLength;
      onChunk?.(value);
    }
  }
  if (target) {
    if (total !== cap) {
      throw new OciError('PROTOCOL', `${what}: received ${total} bytes, expected exactly ${cap}`);
    }
    return target;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Computes `sha256:<hex>` for bytes that were either streamed through
 * `hasher` already, or (default) hashed in one WebCrypto call over the
 * complete buffer.
 */
export async function finishDigest(bytes: Uint8Array<ArrayBuffer>, hasher: OciHasher | undefined): Promise<string> {
  const hex = hasher ? await hasher.digest() : await webCryptoSha256Hex(bytes);
  return `sha256:${hex.toLowerCase()}`;
}
