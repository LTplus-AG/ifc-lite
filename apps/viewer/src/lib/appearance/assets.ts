/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  AppearanceAssetError, DEFAULT_APPEARANCE_ASSET_LIMITS, inspectImage, validateDimensions,
  type AppearanceAssetLimits, type AppearanceImageMime,
} from './asset-format.js';
export { AppearanceAssetError, type AppearanceAssetLimits } from './asset-format.js';

export interface AppearanceAssetOwner {
  kind: 'source' | 'draft' | 'model' | 'history';
  id: string;
}
export interface AppearanceBitmap { readonly width: number; readonly height: number; close(): void }
export interface AppearanceAsset {
  readonly id: string;
  readonly mimeType: AppearanceImageMime;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  /** Full content digest basename avoids ambiguous IFCZIP basename resolution. */
  readonly exportName: string;
}
interface Entry<B extends AppearanceBitmap> {
  asset: Readonly<AppearanceAsset>;
  bytes: Uint8Array;
  owners: Set<string>;
  decoded?: B;
  pending?: Promise<B>;
  reservedBytes: number;
}
export type AppearanceImageDecoder<B extends AppearanceBitmap> = (bytes: Uint8Array, mimeType: AppearanceImageMime) => Promise<B>;

function ownerKey(owner: AppearanceAssetOwner): string {
  if (!owner.id) throw new AppearanceAssetError('owner', 'An appearance asset needs an owner identifier.');
  return JSON.stringify([owner.kind, owner.id]);
}
function cancelled(): Error {
  const error = new Error('Image operation cancelled.');
  error.name = 'AbortError';
  return error;
}
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw cancelled(); }

/** Cancellation belongs to each caller; it must not cancel another owner's shared decode. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

async function browserDecode(bytes: Uint8Array, mimeType: AppearanceImageMime): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') {
    throw new AppearanceAssetError('decode', 'Image decoding is unavailable. Try a browser with image bitmap support.');
  }
  // Copy detaches Blob ownership from inventory storage; preserve source UV/image orientation.
  return createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mimeType }), { imageOrientation: 'none' });
}

/**
 * Session inventory for original encoded images. Own bytes here, never in Zustand.
 * Owners are idempotent leases; each independent consumer needs a distinct owner id.
 * Hold an owner until renderer/history/export use has finished. Final release closes
 * its bitmap, including one returned after release; callers never close shared bitmaps.
 * This is in-memory ownership, not a claim of durable project persistence.
 */
export class AppearanceAssetInventory<B extends AppearanceBitmap = ImageBitmap> {
  private readonly entries = new Map<string, Entry<B>>();
  private readonly limits: AppearanceAssetLimits;
  private readonly decoder: AppearanceImageDecoder<B>;
  private encodedBytes = 0;
  private decodedBytes = 0;
  private generation = 0;

  constructor(options: { decode: AppearanceImageDecoder<B>; limits?: Partial<AppearanceAssetLimits> });
  constructor(options?: B extends ImageBitmap ? { limits?: Partial<AppearanceAssetLimits> } : never);
  constructor(options: { decode?: AppearanceImageDecoder<B>; limits?: Partial<AppearanceAssetLimits> } = {}) {
    this.limits = { ...DEFAULT_APPEARANCE_ASSET_LIMITS, ...options.limits };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new AppearanceAssetError('budget', 'Image budgets must be positive whole numbers.');
    }
    // The default constructor is available only for ImageBitmap; injected decoders
    // use the explicit generic constructor overload above.
    this.decoder = options.decode ?? (browserDecode as AppearanceImageDecoder<B>);
  }

  async add(input: Uint8Array | Blob, options: { owner: AppearanceAssetOwner; mimeType?: string; signal?: AbortSignal }): Promise<Readonly<AppearanceAsset>> {
    const key = ownerKey(options.owner);
    const generation = this.generation;
    checkSignal(options.signal);
    const size = input instanceof Uint8Array ? input.byteLength : input.size;
    if (size === 0 || size > this.limits.maxImageBytes) {
      throw new AppearanceAssetError('size', `Choose an image between 1 and ${this.limits.maxImageBytes} encoded bytes, or resize this image.`);
    }
    const bytes = input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(await input.arrayBuffer());
    checkSignal(options.signal);
    const dimensions = inspectImage(bytes, options.mimeType ?? (input instanceof Uint8Array ? undefined : input.type));
    validateDimensions(dimensions.width, dimensions.height, this.limits);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    checkSignal(options.signal);
    if (generation !== this.generation) throw cancelled();
    const id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const existing = this.entries.get(id);
    if (existing) {
      existing.owners.add(key);
      return existing.asset;
    }
    if (this.encodedBytes + bytes.byteLength > this.limits.maxEncodedBytes) {
      throw new AppearanceAssetError('budget', 'Image storage budget exceeded. Remove unused sources or use smaller images.');
    }
    const asset = Object.freeze({ id, ...dimensions, byteLength: bytes.byteLength, exportName: `textures/${id}.${dimensions.mimeType === 'image/png' ? 'png' : 'jpg'}` });
    this.entries.set(id, { asset, bytes, owners: new Set([key]), reservedBytes: 0 });
    this.encodedBytes += bytes.byteLength;
    return asset;
  }

  get(id: string): Readonly<AppearanceAsset> | undefined { return this.entries.get(id)?.asset; }
  retain(id: string, owner: AppearanceAssetOwner): void { this.entry(id).owners.add(ownerKey(owner)); }
  release(id: string, owner: AppearanceAssetOwner): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.owners.delete(ownerKey(owner));
    if (entry.owners.size === 0) this.drop(id, entry);
  }
  releaseOwner(owner: AppearanceAssetOwner): void {
    const key = ownerKey(owner);
    for (const [id, entry] of this.entries) {
      entry.owners.delete(key);
      if (entry.owners.size === 0) this.drop(id, entry);
    }
  }

  async decode(id: string, owner: AppearanceAssetOwner, signal?: AbortSignal): Promise<B> {
    checkSignal(signal);
    const entry = this.entry(id);
    const key = ownerKey(owner);
    if (!entry.owners.has(key)) throw new AppearanceAssetError('owner', 'Retain this image for the requesting owner before decoding it.');
    if (!entry.pending && !entry.decoded) {
      const cost = entry.asset.width * entry.asset.height * 4;
      if (this.decodedBytes + cost > this.limits.maxDecodedBytes) {
        throw new AppearanceAssetError('budget', 'Decoded image budget exceeded. Close unused models or previews, or choose smaller images.');
      }
      entry.reservedBytes = cost;
      this.decodedBytes += cost;
      entry.pending = this.decodeEntry(id, entry);
    }
    const bitmap = await waitFor(entry.decoded ? Promise.resolve(entry.decoded) : entry.pending!, signal);
    checkSignal(signal);
    if (this.entries.get(id) !== entry || !entry.owners.has(key)) throw cancelled();
    return bitmap;
  }

  /** Defensive copies keep source bytes immutable while exporters build archives. */
  encoded(id: string): Uint8Array<ArrayBuffer> { return new Uint8Array(this.entry(id).bytes); }
  exportResources(ids: Iterable<string>): Map<string, Uint8Array> {
    const resources = new Map<string, Uint8Array>();
    for (const id of ids) {
      const entry = this.entry(id);
      if (!resources.has(entry.asset.exportName)) resources.set(entry.asset.exportName, new Uint8Array(entry.bytes));
    }
    return resources;
  }
  clear(): void {
    this.generation++;
    for (const [id, entry] of this.entries) this.drop(id, entry);
  }

  private entry(id: string): Entry<B> {
    const entry = this.entries.get(id);
    if (!entry) throw new AppearanceAssetError('missing', 'This appearance image was released. Reimport it or restore its source before continuing.');
    return entry;
  }
  private unreserve(entry: Entry<B>): void {
    this.decodedBytes -= entry.reservedBytes;
    entry.reservedBytes = 0;
  }
  private drop(id: string, entry: Entry<B>): void {
    this.entries.delete(id);
    this.encodedBytes -= entry.bytes.byteLength;
    // In-flight decodes still consume their reservation until they settle.
    if (!entry.pending) this.unreserve(entry);
    entry.decoded?.close();
    entry.decoded = undefined;
  }
  private async decodeEntry(id: string, entry: Entry<B>): Promise<B> {
    let bitmap: B | undefined;
    try {
      const decoded = await Promise.resolve().then(() => this.decoder(new Uint8Array(entry.bytes), entry.asset.mimeType));
      bitmap = decoded;
      if (this.entries.get(id) !== entry) throw cancelled();
      validateDimensions(decoded.width, decoded.height, this.limits);
      if (decoded.width !== entry.asset.width || decoded.height !== entry.asset.height) {
        throw new AppearanceAssetError('decode', 'Decoded dimensions do not match the image header. Export the image again without orientation metadata.');
      }
      entry.decoded = decoded;
      return decoded;
    } catch (error) {
      bitmap?.close();
      this.unreserve(entry);
      if (error instanceof AppearanceAssetError || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw new AppearanceAssetError('decode', `Cannot decode this image. Export it again as PNG or JPEG. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      entry.pending = undefined;
    }
  }
}
