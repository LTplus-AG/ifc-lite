/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type {
  AppearanceAssetInventory,
  AppearanceBitmap,
  AppearanceAsset,
} from '../assets.js';
import {
  createPdfWorkerClient,
  type PdfWorkerClient,
} from './worker-client.js';
import {
  PDF_LIMITS,
  PdfAppearanceError,
  type PdfPageInfo,
  type PdfRasterRecipe,
  type PdfRasterRequest,
} from './types.js';
const documentBytes = new WeakMap<object, number>();
const maxDocumentBytes = 128 * 1024 * 1024;
export interface PdfDerivedAppearance {
  /** Session source identity, independent of deduplicated raster content. */
  sourceId: string;
  asset: Readonly<AppearanceAsset>;
  recipe: PdfRasterRecipe;
  documentId: string;
}
/** PDF bytes/password have session ownership only. Model/export paths receive PNG assets. */
export class PdfAppearanceSource<B extends AppearanceBitmap = ImageBitmap> {
  readonly kind = 'pdf';
  private readonly ownerId = `pdf:${crypto.randomUUID()}`;
  private readonly derived = new Set<string>();
  private disposed = false;
  private revision = 0;
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly pageCount: number,
    private bytes: Uint8Array,
    private password: string | undefined,
    private readonly inventory: AppearanceAssetInventory<B>,
    private readonly worker: PdfWorkerClient,
  ) {}
  static async open<B extends AppearanceBitmap>(
    file: File,
    inventory: AppearanceAssetInventory<B>,
    options: {
      signal?: AbortSignal;
      password?: string;
      worker?: PdfWorkerClient;
    } = {},
  ): Promise<PdfAppearanceSource<B>> {
    if (!file.size || file.size > PDF_LIMITS.maxBytes)
      throw new PdfAppearanceError(
        'budget',
        'Choose a PDF no larger than 64 MiB.',
      );
    if (options.signal?.aborted)
      throw new PdfAppearanceError('cancelled', 'PDF import cancelled.');
    const reserved = documentBytes.get(inventory) ?? 0;
    if (reserved + file.size > maxDocumentBytes)
      throw new PdfAppearanceError(
        'budget',
        'PDF source storage is full. Remove unused documents before importing another.',
      );
    documentBytes.set(inventory, reserved + file.size);
    let worker: PdfWorkerClient | undefined;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      worker = options.worker ?? createPdfWorkerClient();
      const result = await worker.run(
        bytes,
        { kind: 'inspect' },
        { signal: options.signal, password: options.password },
      );
      if (result.kind !== 'inspect')
        throw new PdfAppearanceError(
          'render',
          'PDF inspection returned no page information.',
        );
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new Uint8Array(bytes),
      );
      if (options.signal?.aborted)
        throw new PdfAppearanceError('cancelled', 'PDF import cancelled.');
      const id = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      return new PdfAppearanceSource(
        id,
        file.name,
        result.pageCount,
        bytes,
        options.password,
        inventory,
        worker,
      );
    } catch (error) {
      worker?.dispose();
      documentBytes.set(
        inventory,
        (documentBytes.get(inventory) ?? file.size) - file.size,
      );
      throw error;
    }
  }
  async page(
    pageNumber: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<PdfPageInfo> {
    this.check();
    const revision = ++this.revision;
    const result = await this.worker.run(
      this.bytes,
      { kind: 'inspect', pageNumber },
      { ...options, password: this.password },
    );
    if (result.kind !== 'inspect')
      throw new PdfAppearanceError(
        'render',
        'PDF inspection returned no page information.',
      );
    this.check();
    if (revision !== this.revision)
      throw new PdfAppearanceError('cancelled', 'PDF page selection changed.');
    return result.page;
  }
  async rasterize(
    request: PdfRasterRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<PdfDerivedAppearance> {
    this.check();
    const revision = ++this.revision;
    const result = await this.worker.run(
      this.bytes,
      { kind: 'raster', request },
      { ...options, password: this.password },
    );
    if (result.kind !== 'raster')
      throw new PdfAppearanceError(
        'render',
        'PDF rendering returned no image.',
      );
    this.check();
    const owner = {
      kind: 'source' as const,
      id: `${this.ownerId}:job:${revision}`,
    };
    const asset = await this.inventory.add(result.png, {
      owner,
      mimeType: 'image/png',
      signal: options.signal,
    });
    try {
      if (this.disposed || revision !== this.revision)
        throw new PdfAppearanceError(
          'cancelled',
          'PDF page selection changed.',
        );
      this.inventory.retain(asset.id, { kind: 'source', id: this.ownerId });
      this.derived.add(asset.id);
      return {
        sourceId: `${this.ownerId}:page:${revision}`,
        asset,
        recipe: result.recipe,
        documentId: this.id,
      };
    } finally {
      this.inventory.release(asset.id, owner);
    }
  }
  /** Drop the document's temporary raster lease after a catalog/model owner adopts it. */
  releaseRaster(assetId: string): void {
    if (!this.derived.delete(assetId)) return;
    this.inventory.release(assetId, { kind: 'source', id: this.ownerId });
  }
  cancel(): void {
    this.revision++;
    this.worker.cancel();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    this.worker.dispose();
    documentBytes.set(
      this.inventory,
      (documentBytes.get(this.inventory) ?? this.bytes.length) -
        this.bytes.length,
    );
    this.bytes = new Uint8Array();
    this.password = undefined;
    for (const id of this.derived)
      this.inventory.release(id, { kind: 'source', id: this.ownerId });
    this.derived.clear();
  }
  private check(): void {
    if (this.disposed)
      throw new PdfAppearanceError(
        'cancelled',
        'The PDF source was removed. Import it again.',
      );
  }
}
