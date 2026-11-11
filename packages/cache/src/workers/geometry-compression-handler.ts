/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { chooseStoredGeometryChunk, inflateRaw } from '../sections/geometry-codec.js';
import { isCompressionRequest, isInflateRequest, type CompressionResponse } from './geometry-compression-protocol.js';

/** Canonical codec handler shared by the real worker and transport contract tests. */
export async function handleCompressionRequest(
  value: unknown,
  send: (response: CompressionResponse, transfers: ArrayBuffer[]) => void,
): Promise<void> {
  if (isInflateRequest(value)) {
    try {
      const raw = await inflateRaw(new Uint8Array(value.buffer));
      send({ id: value.id, buffer: raw.buffer, compressed: false }, [raw.buffer]);
    } catch (error) {
      send({ id: value.id, error: error instanceof Error ? error.message : String(error) }, []);
    }
    return;
  }
  if (!isCompressionRequest(value)) throw new Error('Invalid geometry compression request');
  try {
    const result = await chooseStoredGeometryChunk(new Uint8Array(value.buffer));
    send({ id: value.id, buffer: result.bytes.buffer, compressed: result.compressed }, [result.bytes.buffer]);
  } catch (error) {
    send({ id: value.id, error: error instanceof Error ? error.message : String(error) }, []);
  }
}
