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
 * The accessor starts resident (`slice` is a `subarray`, no copy) and can
 * switch to block-compressed storage IN PLACE via `compressInPlace`. See
 * {@link MutableSourceBytes} for why in place rather than by replacement --
 * that detail is the difference between a real saving and a silent no-op.
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

import { BlockStore, type BlockedPayload, type BlockStoreCounters } from './block-store.js';
import type { CompressedSource } from './source-compress.js';

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
      /**
       * Required, unlike the contiguous arm's nullable key. A contiguous
       * receiver can recompute a missing key with one linear pass over bytes it
       * already holds; a blocked one would have to inflate every block to do
       * it. Making it non-nullable here forces the compression swap to compute
       * and carry the key eagerly, while the source is still contiguous.
       */
      contentKey: string;
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

/**
 * Clamp a half-open range to `[0, len]`, tolerating reversed or wild input.
 *
 * Only NaN falls back to 0. Infinities are truncated and clamped like any
 * other out-of-range number, so `decodeUtf8(2, Infinity)` means "to the end"
 * rather than the empty string — a caller expressing an open upper bound that
 * way should get the remainder, not silence.
 */
function clampRange(start: number, end: number, len: number): [number, number] {
  const clamp = (v: number): number =>
    Number.isNaN(v) ? 0 : Math.max(0, Math.min(Math.trunc(v), len));
  const s = clamp(start);
  const e = clamp(end);
  return e < s ? [s, s] : [s, e];
}

/**
 * The source accessor. Starts resident and can switch to block-compressed
 * storage IN PLACE.
 *
 * In place, not by replacement, and this is not a style choice (#2183):
 * `attachDataStoreAccessors` captures this object in a `BufferEntitySource`
 * whose `EntityExtractor` holds it for the store's lifetime, so `getEntity`
 * would keep reading the old resident view after a replacement -- the original
 * buffer would stay alive and the memory win would be exactly zero, silently.
 * Worse, `getProperties` goes through `extractPropertiesOnDemand`, which
 * constructs a fresh extractor from `store.source` on EVERY call, so a
 * replacement would split-brain the store: properties served from the
 * compressed source, entities from the resident one, both retained.
 *
 * Mutating the single shared instance makes every holder -- the captured
 * extractors, the hook closures, the partial and final stores that already
 * share one accessor by design -- observe the switch through object identity.
 * The whole class of stale-holder bugs cannot arise.
 */
class MutableSourceBytes implements IfcSourceBytes {
  /** Non-null exactly while resident. */
  #view: Uint8Array | null;
  /** Non-null exactly while compressed. Never both. */
  #blocks: BlockStore | null = null;
  /**
   * Depth of open {@link withMaterialized} windows, and the buffer they share.
   *
   * Only meaningful while compressed: a resident `withMaterialized` hands out
   * the real view and needs no window at all.
   */
  #windowDepth = 0;
  #window: Uint8Array | null = null;
  /**
   * `undefined` = not computed yet, `string` = computed. Never `null` for a
   * non-empty source: the constructor no longer accepts one, so the state
   * "permanently keyed on nothing" -- which reads downstream as an overlay
   * silently not rendering -- is unrepresentable rather than merely unused.
   */
  #contentKey: string | undefined;

  constructor(view: Uint8Array, contentKey?: string) {
    this.#view = view;
    this.#contentKey = contentKey;
  }

  get isResident(): boolean { return this.#view !== null; }

  get byteLength(): number {
    return this.#view !== null ? this.#view.byteLength : this.#blocks!.totalLength;
  }

  get length(): number { return this.byteLength; }

  /** Compressed-storage stats, or null while resident. For the dev counter. */
  get blockStats(): { stored: number; resident: number; counters: BlockStoreCounters } | null {
    if (this.#blocks === null) return null;
    return {
      stored: this.#blocks.storedBytes,
      resident: this.#blocks.residentBytes,
      counters: this.#blocks.counters,
    };
  }

  /**
   * Switch to compressed storage, dropping the resident buffer.
   *
   * Synchronous and single-assignment, so no read can observe a torn state: a
   * read either precedes the switch and sees the view, or follows it and
   * inflates. Idempotent -- a second call is a no-op rather than a re-compress.
   *
   * Safe to call inside a `withMaterialized` callback. That callback holds a
   * real `Uint8Array` reference, which stays valid and correct after the
   * switch; it simply stops being the source's storage, and the buffer becomes
   * collectable when the callback returns. (An earlier draft deferred the
   * switch until the window closed. That branch was unreachable: window depth
   * only rises while compressed, and this method returns early when compressed.
   * Unreachable safety machinery is worse than none -- it reads as a handled
   * case.)
   */
  compressInPlace(payload: CompressedSource): void {
    if (this.#view === null) return;
    if (payload.totalLength !== this.#view.byteLength) {
      throw new Error(
        `compressInPlace: payload is ${payload.totalLength} bytes but the source is `
        + `${this.#view.byteLength}; refusing to swap in bytes that are not this source`,
      );
    }
    this.#applyCompression(payload);
  }

  /**
   * Adopt already-compressed blocks, for rebuilding a source that crossed a
   * thread boundary. Distinct from {@link compressInPlace}, which starts from
   * resident bytes and must guard that the payload describes THIS source;
   * here there are no bytes to check against.
   */
  adoptBlocks(payload: BlockedPayload & { contentKey: string }): void {
    this.#contentKey ??= payload.contentKey;
    this.#blocks = new BlockStore(payload);
    this.#view = null;
  }

  #applyCompression(payload: CompressedSource): void {
    // Take the key from the payload: it was computed while the bytes were
    // contiguous, which is the only cheap moment. Never recompute after.
    this.#contentKey ??= payload.contentKey;
    this.#blocks = new BlockStore(payload);
    this.#view = null;
  }

  get contentKey(): string {
    // Lazy while resident: only the callers that key a cache on identity pay
    // for it, and they pay once. Nothing on the load path needs it.
    //
    // Always a string, never null: `contiguousSourceBytes` collapses a
    // zero-length view to EMPTY_SOURCE_BYTES, so this is non-empty by
    // construction and the "no source" key has nowhere to appear.
    //
    // Once compressed it is always already set -- compressInPlace takes it
    // from the payload -- so this never inflates anything to hash it.
    this.#contentKey ??= fnv1a(this.#view!);
    return this.#contentKey;
  }

  slice(start: number, end: number): Uint8Array {
    const [s, e] = clampRange(start, end, this.byteLength);
    if (this.#view !== null) return this.#view.subarray(s, e);
    return this.#blocks!.read(s, e);
  }

  decodeUtf8(start: number, end: number): string {
    const [s, e] = clampRange(start, end, this.byteLength);
    if (e === s) return '';
    if (this.#view !== null) {
      // SAB-safe: the source is usually SharedArrayBuffer-backed, which raw
      // `TextDecoder.decode` rejects.
      return safeUtf8Decode(this.#view, s, e);
    }
    return this.#blocks!.decodeUtf8(s, e);
  }

  /**
   * While compressed this inflates the WHOLE source (~1.8 s and 343 MB on the
   * reference model), so prefer {@link withMaterialized}, which at least
   * scopes the buffer and shares it between nested calls.
   */
  materialize(): Uint8Array {
    if (this.#view !== null) return this.#view;
    return this.#window ?? this.#blocks!.materialize();
  }

  withMaterialized<T>(fn: (bytes: Uint8Array) => T): T {
    if (this.#view !== null) return fn(this.#view);
    this.#openWindow();
    try {
      return fn(this.#window!);
    } finally {
      this.#closeWindow();
    }
  }

  async withMaterializedAsync<T>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> {
    if (this.#view !== null) return fn(this.#view);
    this.#openWindow();
    try {
      return await fn(this.#window!);
    } finally {
      this.#closeWindow();
    }
  }

  /**
   * Inflate once for the duration of a callback. Nested windows share the one
   * buffer, so two overlapping consumers do not each allocate the whole file.
   */
  #openWindow(): void {
    if (this.#windowDepth === 0) this.#window = this.#blocks!.materialize();
    this.#windowDepth++;
  }

  #closeWindow(): void {
    this.#windowDepth--;
    if (this.#windowDepth === 0) this.#window = null;
  }

  toTransferable(): IfcSourceTransfer {
    // Deliberately reads the memo FIELD, not the getter. This method exists to
    // hand a source to a worker without paying whole-file costs on the sending
    // thread, and `contentKey` is a full-file FNV-1a walk -- forcing it here
    // would make the documented "without materialising" path allocate and walk
    // the whole 342 MB source on the main thread, which is what #2183 is about.
    // Pass the key on only when something has already computed it; a receiver
    // that needs one computes it lazily, on its own thread, to the same value.
    if (this.#view !== null) {
      return { kind: 'contiguous', bytes: this.#view, contentKey: this.#contentKey ?? null };
    }
    // Compressed: post the BLOCKS, not the inflated file -- 67 MB instead of
    // 343 MB on the reference model, and the receiving thread does any
    // inflating. The key is always known by now (compressInPlace took it from
    // the payload), which is why the blocked arm declares it required.
    return { kind: 'blocked', ...this.#blocks!.toPayload(), contentKey: this.contentKey };
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
  contentKey?: string,
): IfcSourceBytes {
  if (!view || view.byteLength === 0) return EMPTY_SOURCE_BYTES;
  return new MutableSourceBytes(view, contentKey);
}

/**
 * Rebuild a source from {@link IfcSourceBytes.toTransferable} output.
 *
 * `contentKey: null` on the wire means "the sender had not computed one", NOT
 * "the key is null" -- `toTransferable` deliberately does not force the
 * full-file hash. So it maps to `undefined` here, which is the constructor's
 * "not computed yet" state, and the receiver hashes lazily on its own thread if
 * anything asks. Passing the `null` straight through would pin the key at null
 * forever and every downstream cache would key on nothing.
 *
 * A non-empty source cannot legitimately have a null key: `fnv1a` always
 * returns a string, and a zero-length view collapses to
 * {@link EMPTY_SOURCE_BYTES} before it can reach a constructor.
 *
 * CONSTRAINT FOR THE BLOCKED IMPLEMENTATION. A contiguous receiver can shrug
 * off a missing key because recomputing it is one linear pass over bytes it
 * already holds. A blocked one cannot -- it would have to inflate every block
 * to hash them. So the compression swap must compute and carry `contentKey`
 * EAGERLY, at swap time, while the bytes are still contiguous. Inheriting the
 * lazy contiguous behaviour there would turn the first cache lookup into a
 * full decompression of the model.
 */
export function sourceBytesFromTransferable(transfer: IfcSourceTransfer): IfcSourceBytes {
  if (transfer.kind === 'contiguous') {
    return contiguousSourceBytes(transfer.bytes, transfer.contentKey ?? undefined);
  }
  // A blocked source rebuilds without inflating anything: the receiver gets
  // the compressed blocks and pays only for the ranges it actually reads.
  const rebuilt = new MutableSourceBytes(new Uint8Array(0), transfer.contentKey);
  rebuilt.adoptBlocks(transfer);
  return rebuilt;
}

/**
 * Switch a source to block-compressed storage, in place.
 *
 * Returns true when the source is now compressed (or already was), false when
 * it cannot be -- an empty source, or one whose bytes do not match the
 * payload. Exported as a function rather than a method on `IfcSourceBytes`
 * deliberately: consumers must never see a source that can change shape under
 * them, so the capability lives with whoever owns the load, not on the read
 * interface every hook holds.
 */
export function compressSourceInPlace(
  source: IfcSourceBytes,
  payload: CompressedSource,
): boolean {
  if (!(source instanceof MutableSourceBytes)) return false;
  source.compressInPlace(payload);
  return true;
}

/** Compressed-storage stats for the dev counter, or null while resident. */
export function sourceBlockStats(
  source: IfcSourceBytes,
): { stored: number; resident: number; counters: BlockStoreCounters } | null {
  return source instanceof MutableSourceBytes ? source.blockStats : null;
}

/**
 * Narrowing helper for the call sites that accept either shape.
 *
 * Checks every member EXCEPT `contentKey`, deliberately: that is a lazy getter
 * which hashes the whole file on first read, and this predicate runs inside
 * `asSourceBytes` — i.e. in the `EntityExtractor` constructor. Probing it here
 * would turn a type check into a full-file scan.
 */
export function isSourceBytes(value: unknown): value is IfcSourceBytes {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<IfcSourceBytes>;
  return (
    typeof s.byteLength === 'number'
    && typeof s.length === 'number'
    && typeof s.isResident === 'boolean'
    && typeof s.slice === 'function'
    && typeof s.decodeUtf8 === 'function'
    && typeof s.materialize === 'function'
    && typeof s.withMaterialized === 'function'
    && typeof s.withMaterializedAsync === 'function'
    && typeof s.toTransferable === 'function'
  );
}

/** Accept either shape and normalise. Lets a helper widen without its callers
 *  changing, which is what keeps the migration diff small. */
export function asSourceBytes(value: Uint8Array | IfcSourceBytes): IfcSourceBytes {
  return isSourceBytes(value) ? value : contiguousSourceBytes(value);
}
