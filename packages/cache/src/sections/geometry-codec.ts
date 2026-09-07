/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

async function pipeThrough(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  // Copy into an owned ArrayBuffer for Blob, including inputs with shared backing.
  const standalone = new Uint8Array(data);
  const out = await new Response(new Blob([standalone]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

export const deflateRaw = (data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> =>
  pipeThrough(data, new CompressionStream('deflate-raw'));

export const inflateRaw = (data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> =>
  pipeThrough(data, new DecompressionStream('deflate-raw'));

/** Same codec and strictly-smaller selection on either side of the worker boundary. */
export async function chooseStoredGeometryChunk(raw: Uint8Array<ArrayBuffer>) {
  const compressed = await deflateRaw(raw);
  return compressed.byteLength < raw.byteLength
    ? { bytes: compressed, compressed: true }
    : { bytes: raw, compressed: false };
}
