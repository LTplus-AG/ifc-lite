/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Optional 16-byte cell: length low/high, hash, ready. Never reused across loads. */
export function publishPrepassFingerprint(cell: SharedArrayBuffer | undefined, byteLength: number, event: unknown): void {
  if (!cell || cell.byteLength !== 16 || typeof event !== 'object' || event === null) return;
  if (!('type' in event) || event.type !== 'complete') return;
  if (!('sourceContentKey' in event) || typeof event.sourceContentKey !== 'string') return;
  const match = /^([0-9a-f]+)-([0-9a-f]{1,8})$/.exec(event.sourceContentKey);
  const words = new Uint32Array(cell);
  if (!match || match[1] !== byteLength.toString(16)
    || words[0] + words[1] * 0x100000000 !== byteLength) {
    console.warn('[prepass] Ignoring mismatched source fingerprint');
    return;
  }
  Atomics.store(words, 2, Number.parseInt(match[2], 16));
  Atomics.store(words, 3, 1);
}

type SerialArgs = [Uint8Array, (event: unknown) => void, number, string[] | undefined, boolean];
type ShardedColumns = [Uint32Array, Uint32Array, Uint32Array, Uint8Array];
interface PrepassApi {
  buildPrePassStreaming(...args: SerialArgs): unknown;
  buildPrePassStreamingWithSourceFingerprint?: (...args: SerialArgs) => unknown;
  buildPrePassStreamingSharded(...args: [...SerialArgs, ...ShardedColumns]): unknown;
  buildPrePassStreamingShardedWithSourceFingerprint?: (...args: [...SerialArgs, ...ShardedColumns]) => unknown;
}

/** Feature detection preserves old WASM pairs and existing Rust method signatures. */
export function runPrepassWithFingerprint(api: unknown, args: SerialArgs, cell?: SharedArrayBuffer, columns?: ShardedColumns): unknown {
  const wasm = api as PrepassApi;
  if (columns) {
    const method = cell && typeof wasm.buildPrePassStreamingShardedWithSourceFingerprint === 'function'
      ? wasm.buildPrePassStreamingShardedWithSourceFingerprint : wasm.buildPrePassStreamingSharded;
    return method.call(wasm, ...args, ...columns);
  }
  const method = cell && typeof wasm.buildPrePassStreamingWithSourceFingerprint === 'function'
    ? wasm.buildPrePassStreamingWithSourceFingerprint : wasm.buildPrePassStreaming;
  return method.call(wasm, ...args);
}
