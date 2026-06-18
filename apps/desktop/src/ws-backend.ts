/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser client for `ifc-lite-desktop-server` (the localhost WebSocket native
 * backend). This is what makes the app run as a **plain web app with native
 * speed**: instead of WASM, geometry is processed by native Rust on localhost
 * and streamed back as packed shards.
 *
 * The shard decoder mirrors `@ifc-lite/geometry`'s `packed-geometry-decoder.ts`.
 * (It is re-implemented here rather than imported because this reference app
 * consumes the *published* package, which does not export that internal helper —
 * and the server owns the format, which is pinned by a Rust round-trip test.)
 */

export interface DecodedMesh {
  expressId: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: [number, number, number, number];
}

export interface NativeBatch {
  meshes: DecodedMesh[];
  processed: number;
  total: number;
}

export interface NativeStats {
  totalMeshes: number;
  totalVertices: number;
  totalTriangles: number;
  parseTimeMs: number;
  geometryTimeMs: number;
  totalTimeMs: number;
}

export interface NativeBackendHandlers {
  onBatch: (batch: NativeBatch) => void;
  onColorUpdate?: (updates: Map<number, [number, number, number, number]>) => void;
}

const SHARD_MAGIC = 0x49464342; // "IFCB"

/** Decode one packed shard buffer (matches the Rust `encode_shard` layout). */
function decodeShard(buffer: ArrayBuffer): NativeBatch {
  const header = new Uint32Array(buffer, 0, 8);
  const [magic, version, meshCount, positionsLen, normalsLen, indicesLen, processed, total] = header;
  if (magic !== SHARD_MAGIC) throw new Error('Invalid packed shard magic');
  if (version !== 1) throw new Error(`Unsupported packed shard version: ${version}`);

  const meshRecordWords = 11;
  const meshWordOffset = 8;
  const dataByteOffset = (meshWordOffset + meshCount * meshRecordWords) * 4;
  const positionsOffset = dataByteOffset;
  const normalsOffset = positionsOffset + positionsLen * 4;
  const indicesOffset = normalsOffset + normalsLen * 4;

  const positions = new Float32Array(buffer, positionsOffset, positionsLen);
  const normals = new Float32Array(buffer, normalsOffset, normalsLen);
  const indices = new Uint32Array(buffer, indicesOffset, indicesLen);
  const meshView = new DataView(buffer, meshWordOffset * 4, meshCount * meshRecordWords * 4);

  const meshes: DecodedMesh[] = [];
  for (let i = 0; i < meshCount; i += 1) {
    const base = i * meshRecordWords * 4;
    const expressId = meshView.getUint32(base, true);
    const posOff = meshView.getUint32(base + 4, true);
    const posLen = meshView.getUint32(base + 8, true);
    const nrmOff = meshView.getUint32(base + 12, true);
    const nrmLen = meshView.getUint32(base + 16, true);
    const idxOff = meshView.getUint32(base + 20, true);
    const idxLen = meshView.getUint32(base + 24, true);
    const color: [number, number, number, number] = [
      meshView.getFloat32(base + 28, true),
      meshView.getFloat32(base + 32, true),
      meshView.getFloat32(base + 36, true),
      meshView.getFloat32(base + 40, true),
    ];
    meshes.push({
      expressId,
      positions: positions.subarray(posOff, posOff + posLen),
      normals: normals.subarray(nrmOff, nrmOff + nrmLen),
      indices: indices.subarray(idxOff, idxOff + idxLen),
      color,
    });
  }

  return { meshes, processed, total };
}

/**
 * Stream geometry for `bytes` from the native backend at `url`
 * (e.g. `ws://127.0.0.1:8082/geometry`). Resolves with the final stats once the
 * server sends its `done` frame.
 */
export function streamFromNativeBackend(
  url: string,
  bytes: Uint8Array,
  handlers: NativeBackendHandlers,
): Promise<NativeStats> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // Upload in chunks, then an {"type":"eof"} marker (the server accumulates
      // binary frames until eof). Chunking keeps peak memory low — a single
      // whole-file copy OOMs the tab on large models. Each chunk is copied into
      // a fresh buffer so it sends regardless of the view's backing store.
      const CHUNK = 16 * 1024 * 1024;
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
        ws.send(bytes.slice(offset, Math.min(offset + CHUNK, bytes.byteLength)));
      }
      ws.send(JSON.stringify({ type: 'eof' }));
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        try {
          handlers.onBatch(decodeShard(event.data));
        } catch (err) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
          ws.close();
        }
        return;
      }
      // Text control frame.
      let msg: { type: string; stats?: NativeStats; updates?: [number, [number, number, number, number]][]; message?: string };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (msg.type === 'done') {
        settled = true;
        resolve(msg.stats as NativeStats);
      } else if (msg.type === 'error') {
        settled = true;
        reject(new Error(msg.message ?? 'native backend error'));
      } else if (msg.type === 'colorUpdate' && handlers.onColorUpdate && msg.updates) {
        const map = new Map<number, [number, number, number, number]>();
        for (const [id, color] of msg.updates) map.set(id, color);
        handlers.onColorUpdate(map);
      }
    };

    ws.onerror = () => {
      if (!settled) reject(new Error(`Cannot reach native backend at ${url}. Is ifc-lite-desktop-server running?`));
    };
    ws.onclose = () => {
      if (!settled) reject(new Error('Native backend closed the connection before completing.'));
    };
  });
}
