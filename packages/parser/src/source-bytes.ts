/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IFC source bytes, behind an accessor instead of a bare `Uint8Array`.
 *
 * Why this exists (#2183). `IfcDataStore.source` is the whole file, kept
 * resident for the lifetime of the model because on-demand property and
 * attribute reads slice it synchronously — during React render, in eight
 * separate chains. On a 342 MB model that is 327 MB of the ~671 MB the
 * viewer's main thread holds, and it is the single largest resident.
 *
 * The contract "here are all the bytes, contiguous, resident forever" is what
 * blocks any cheaper representation. Replacing it with "ask for the range you
 * need" makes every whole-file consumer visible, which is a property you
 * cannot retrofit later, and it is the precondition for storing the source
 * compressed in blocks.
 *
 * This module ships ONLY the contiguous implementation. It is deliberately a
 * behavioural no-op: `ContiguousSourceBytes.slice` is a `subarray`, so there
 * is no copy and no perf claim to defend. The blocked implementation lands
 * separately, behind the same interface.
 *
 * Design notes that are load-bearing rather than stylistic:
 *
 *   - `length` is an alias of `byteLength`. It exists so the ~79 existing
 *     `!store.source?.length` guards keep compiling AND keep meaning exactly
 *     what they mean today. Two of them are semantic discriminators, not
 *     defensive noise: `packages/ids/src/bridge/properties.ts` uses
 *     source-presence to mean "WASM store, not server store", and
 *     `material-resolver.ts` uses it to decide cache safety. Do not add new
 *     uses; prefer `byteLength`.
 *   - `byteLength === 0` is a real, supported state, not an error. Server
 *     parsed stores, synthetic stores, GLB and point-cloud models all have no
 *     source. {@link EMPTY_SOURCE_BYTES} models it.
 *   - `contentKey` is computed lazily and memoised. It replaces two
 *     hand-rolled hashes in the viewer, one of which walks the whole file on
 *     every call and one of which keys a cache on `byteLength` alone (and so
 *     collides across same-size models).
 */

import { safeUtf8Decode } from '@ifc-lite/data';

/**
 * Structured-clone-safe description of a source, for handing it to a worker
 * WITHOUT materialising it on the sending side.
 *
 * `blocked` is declared here but not yet produced; it is the shape the
 * compressed implementation will post.
 */
export type IfcSourceTransfer =
  | { kind: 'contiguous'; bytes: Uint8Array; contentKey: string | null }
  | {
      kind: 'blocked';
      blocks: Uint8Array;
      index: Uint32Array;
      storedMask: Uint8Array;
      blockSize: number;
      totalLength: number;
      contentKey: string | null;
    };

export interface IfcSourceBytes {
  /** Logical (uncompressed) length. `0` means "this model has no source". */
  readonly byteLength: number;

  /**
   * Alias of {@link byteLength}, kept so existing `?.length` guards compile
   * and behave identically. Prefer `byteLength` in new code.
   */
  readonly length: number;

  /** True when the bytes are contiguous and resident: `slice` is a view and
   *  `materialize` is free. */
  readonly isResident: boolean;

  /** Stable identity of the CONTENT. `null` when there is no source. */
  readonly contentKey: string | null;

  /**
   * Bytes in `[start, end)`. Clamped to the source and never throws, so a
   * caller reading a stale byte range gets an empty or short view rather than
   * an exception. Returns a view when resident.
   */
  slice(start: number, end: number): Uint8Array;

  /** UTF-8 decode of `[start, end)`, without allocating an intermediate view
   *  when the implementation can avoid it. This is the hot path. */
  decodeUtf8(start: number, end: number): string;

  /**
   * The whole source as one contiguous view. May allocate `byteLength` bytes,
   * so callers must drop the result promptly. Prefer
   * {@link withMaterialized}, which makes that structural.
   */
  materialize(): Uint8Array;

  /** Scoped {@link materialize}: the buffer cannot outlive the callback. */
  withMaterialized<T>(fn: (bytes: Uint8Array) => T): T;

  /** Async form of {@link withMaterialized}. */
  withMaterializedAsync<T>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T>;

  /** Describe the source for a worker without materialising it here. */
  toTransferable(): IfcSourceTransfer;
}

/** FNV-1a over the whole buffer. Matches the viewer's existing source hash. */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length.toString(16)}-${(h >>> 0).toString(16)}`;
}

/** Clamp a half-open range to `[0, len]`, tolerating reversed or wild input. */
function clampRange(start: number, end: number, len: number): [number, number] {
  const s = Number.isFinite(start) ? Math.max(0, Math.min(Math.trunc(start), len)) : 0;
  const e = Number.isFinite(end) ? Math.max(0, Math.min(Math.trunc(end), len)) : 0;
  return e < s ? [s, s] : [s, e];
}

class ContiguousSourceBytes implements IfcSourceBytes {
  readonly isResident = true;
  #view: Uint8Array;
  #contentKey: string | null | undefined;

  constructor(view: Uint8Array, contentKey?: string | null) {
    this.#view = view;
    this.#contentKey = contentKey;
  }

  get byteLength(): number { return this.#view.byteLength; }
  get length(): number { return this.#view.byteLength; }

  get contentKey(): string | null {
    if (this.#contentKey === undefined) {
      // Lazy: only the callers that key a cache on identity pay for it, and
      // they pay once. Nothing on the load path needs it.
      this.#contentKey = this.#view.byteLength === 0 ? null : fnv1a(this.#view);
    }
    return this.#contentKey;
  }

  slice(start: number, end: number): Uint8Array {
    const [s, e] = clampRange(start, end, this.#view.byteLength);
    return this.#view.subarray(s, e);
  }

  decodeUtf8(start: number, end: number): string {
    const [s, e] = clampRange(start, end, this.#view.byteLength);
    if (e === s) return '';
    // SAB-safe: the source is usually SharedArrayBuffer-backed, which raw
    // `TextDecoder.decode` rejects.
    return safeUtf8Decode(this.#view, s, e);
  }

  materialize(): Uint8Array { return this.#view; }

  withMaterialized<T>(fn: (bytes: Uint8Array) => T): T { return fn(this.#view); }

  withMaterializedAsync<T>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> {
    return fn(this.#view);
  }

  toTransferable(): IfcSourceTransfer {
    return { kind: 'contiguous', bytes: this.#view, contentKey: this.contentKey };
  }
}

/**
 * The no-source state, shared. Frozen and stateless, so it is safe to hand the
 * same instance to every store that has no bytes.
 */
class EmptySourceBytes implements IfcSourceBytes {
  readonly byteLength = 0;
  readonly length = 0;
  readonly isResident = true;
  readonly contentKey = null;

  // A FRESH array each call: callers occasionally write into what they get
  // back, and a shared mutable empty would couple them.
  slice(): Uint8Array { return new Uint8Array(0); }
  decodeUtf8(): string { return ''; }
  materialize(): Uint8Array { return new Uint8Array(0); }
  withMaterialized<T>(fn: (bytes: Uint8Array) => T): T { return fn(new Uint8Array(0)); }
  withMaterializedAsync<T>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> {
    return fn(new Uint8Array(0));
  }
  toTransferable(): IfcSourceTransfer {
    return { kind: 'contiguous', bytes: new Uint8Array(0), contentKey: null };
  }
}

/** The canonical "this model has no source" value. */
export const EMPTY_SOURCE_BYTES: IfcSourceBytes = Object.freeze(new EmptySourceBytes());

/**
 * Wrap a resident buffer. Zero-copy: `slice` returns views into `view`.
 *
 * Pass `contentKey` when it is already known (e.g. carried across a worker
 * boundary or a compression swap) so downstream caches do not invalidate.
 */
export function contiguousSourceBytes(
  view: Uint8Array | null | undefined,
  contentKey?: string | null,
): IfcSourceBytes {
  if (!view || view.byteLength === 0) return EMPTY_SOURCE_BYTES;
  return new ContiguousSourceBytes(view, contentKey);
}

/** Rebuild a source from {@link IfcSourceBytes.toTransferable} output. */
export function sourceBytesFromTransferable(transfer: IfcSourceTransfer): IfcSourceBytes {
  if (transfer.kind === 'contiguous') {
    return contiguousSourceBytes(transfer.bytes, transfer.contentKey);
  }
  throw new Error(
    'sourceBytesFromTransferable: blocked sources are not implemented yet (#2183)',
  );
}

/** Narrowing helper for the call sites that accept either shape. */
export function isSourceBytes(value: unknown): value is IfcSourceBytes {
  return (
    typeof value === 'object' && value !== null
    && typeof (value as IfcSourceBytes).decodeUtf8 === 'function'
    && typeof (value as IfcSourceBytes).slice === 'function'
    && typeof (value as IfcSourceBytes).byteLength === 'number'
  );
}

/** Accept either shape and normalise. Lets a helper widen without its callers
 *  changing, which is what keeps the migration diff small. */
export function asSourceBytes(value: Uint8Array | IfcSourceBytes): IfcSourceBytes {
  return isSourceBytes(value) ? value : contiguousSourceBytes(value);
}
