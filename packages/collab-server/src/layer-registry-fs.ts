/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Disk-backed layer registry — the durable counterpart to
 * `MemoryLayerRegistry`, for deployments with a mounted volume (the same
 * `COLLAB_DATA_DIR` that backs `FilePersistence` and `FsBlobStorage`).
 *
 * Layout under `<dataDir>/layer-registry/`:
 *   layers/<blake3-hex>.json   one file per content-addressed layer
 *   refs.json                  the whole ref record (names are arbitrary
 *                              strings, so they never become filenames)
 *   reviews/<id>.json          one file per review object
 *
 * Layers live on disk only and are read on demand: keeping every layer in
 * RAM is exactly the hosting-cost/durability trade the blob route already
 * rejected. Refs and reviews are small and gate merges, so they hydrate
 * into memory at boot and write through on every change.
 *
 * Writes are synchronous (atomic temp + rename): the `LayerRegistryStore`
 * interface is sync, registry operations are rare, payloads are bounded by
 * the route's `maxBytes`, and a registry must be durable before it acks —
 * an accepted push that evaporates on restart would silently break refs.
 *
 * Hydration fails closed: a corrupt refs or review file throws at
 * construction instead of starting empty, because an empty start would
 * drop protected-ref policies and recorded approvals — the exact gates
 * this store exists to persist.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IfcxFile } from '@ifc-lite/ifcx';
import type { RefEntry } from '@ifc-lite/merge';
import {
  assertPushableLayer,
  assertReportDigest,
  LayerPushError,
  type LayerRegistryStore,
  type MemoryLayerRegistryLimits,
  type RegistryReview,
} from './layer-registry.js';

/** `blake3:<hex>` — the only id shape `computeLayerId` emits. Anything else
 *  is rejected before it can become a filename (no traversal). */
const LAYER_ID_REGEX = /^blake3:([0-9a-f]{64})$/;
/** Review ids are route-minted UUIDs; permit that shape only. */
const REVIEW_ID_REGEX = /^[0-9a-fA-F-]{1,64}$/;

export class FsLayerRegistry implements LayerRegistryStore {
  private readonly layersDir: string;
  private readonly reviewsDir: string;
  private readonly reportsDir: string;
  private readonly refsFile: string;
  private readonly refs = new Map<string, RefEntry>();
  private readonly reviews = new Map<string, RegistryReview>();
  private layerCount: number;
  private reportCount: number;
  private readonly maxLayers: number;
  private readonly maxRefs: number;
  private readonly maxReviews: number;
  private readonly maxReports: number;

  constructor(dataDir: string, limits: MemoryLayerRegistryLimits = {}) {
    this.maxLayers = limits.maxLayers ?? 10_000;
    this.maxRefs = limits.maxRefs ?? 1_000;
    this.maxReviews = limits.maxReviews ?? 10_000;
    this.maxReports = limits.maxReports ?? 10_000;
    const root = path.join(dataDir, 'layer-registry');
    this.layersDir = path.join(root, 'layers');
    this.reviewsDir = path.join(root, 'reviews');
    this.reportsDir = path.join(root, 'reports');
    this.refsFile = path.join(root, 'refs.json');
    fs.mkdirSync(this.layersDir, { recursive: true });
    fs.mkdirSync(this.reviewsDir, { recursive: true });
    fs.mkdirSync(this.reportsDir, { recursive: true });
    this.layerCount = this.listLayerFiles().length;
    this.reportCount = fs.readdirSync(this.reportsDir).filter((n) => /^[0-9a-f]{64}$/.test(n)).length;
    this.hydrateRefs();
    this.hydrateReviews();
  }

  private hydrateRefs(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.refsFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // fresh registry
      throw err;
    }
    const parsed = JSON.parse(raw) as Record<string, RefEntry>;
    for (const [name, entry] of Object.entries(parsed)) this.refs.set(name, entry);
  }

  private hydrateReviews(): void {
    for (const name of fs.readdirSync(this.reviewsDir)) {
      if (!name.endsWith('.json')) continue; // skip in-flight temp files
      const review = JSON.parse(
        fs.readFileSync(path.join(this.reviewsDir, name), 'utf8')
      ) as RegistryReview;
      this.reviews.set(review.id, review);
    }
  }

  private listLayerFiles(): string[] {
    return fs.readdirSync(this.layersDir).filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
  }

  private layerFile(layerId: string): string | undefined {
    const m = LAYER_ID_REGEX.exec(layerId);
    return m ? path.join(this.layersDir, `${m[1]}.json`) : undefined;
  }

  private writeAtomic(target: string, data: string | Uint8Array): void {
    const tmp = `${target}.tmp-${crypto.randomUUID()}`;
    // fsync before rename: "durable before ack" must hold through power
    // loss, not just process crash — rename alone leaves the data in the
    // page cache.
    const fd = fs.openSync(tmp, 'w');
    try {
      // writeSync's overloads take a buffer OR a string, never the union —
      // normalize to a buffer before the call.
      fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf-8') : data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  }

  push(file: IfcxFile): string {
    const id = assertPushableLayer(file);
    const target = this.layerFile(id);
    if (!target) throw new LayerPushError('id-mismatch', `unsupported content-address shape ${id}`);
    const bytes = JSON.stringify(file);
    // First write wins (same rationale as the memory store): a re-push of an
    // existing id must be byte-identical, or an attacker could swap the
    // non-canonical parts (signatures, derived content) under a trusted id.
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(target, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (existing !== undefined) {
      if (existing !== bytes) {
        throw new LayerPushError(
          'content-conflict',
          `layer ${id} already exists with different non-canonical bytes; refusing overwrite`
        );
      }
      return id;
    }
    if (this.layerCount >= this.maxLayers) {
      throw new LayerPushError('registry-full', `registry holds ${this.layerCount} layers (cap ${this.maxLayers})`);
    }
    this.writeAtomic(target, bytes);
    this.layerCount += 1;
    return id;
  }

  hasLayer(layerId: string): boolean {
    const file = this.layerFile(layerId);
    return file !== undefined && fs.existsSync(file);
  }

  listLayers(): string[] {
    return this.listLayerFiles().map((n) => `blake3:${n.slice(0, -'.json'.length)}`);
  }

  // LayerRefStore — consumed by the shared merge flow. The disk round-trip
  // gives callers an isolated copy for free (no shared references).
  loadLayer(layerId: string): IfcxFile {
    const file = this.layerFile(layerId);
    if (file !== undefined) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as IfcxFile;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    throw new Error(`No layer ${layerId} in registry`);
  }

  storeLayer(file: IfcxFile): string {
    // Merge layers arrive from the shared flow already content-addressed;
    // run them through the same integrity gate as external pushes.
    return this.push(file);
  }

  getRef(name: string): RefEntry | undefined {
    const entry = this.refs.get(name);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  setRef(name: string, entry: RefEntry): void {
    if (!this.refs.has(name) && this.refs.size >= this.maxRefs) {
      throw new LayerPushError('registry-full', `registry holds ${this.refs.size} refs (cap ${this.maxRefs})`);
    }
    const next: RefEntry = structuredClone({
      layers: entry.layers,
      ...(entry.policy ? { policy: entry.policy } : {}),
    });
    // Persist before committing to memory: if the write throws, the served
    // state still matches disk.
    const record = Object.fromEntries([...this.refs.entries(), [name, next]]);
    this.writeAtomic(this.refsFile, JSON.stringify(record));
    this.refs.set(name, next);
  }

  listRefs(): Record<string, RefEntry> {
    return Object.fromEntries(
      [...this.refs.entries()].map(([name, entry]) => [name, structuredClone(entry)])
    );
  }

  getReview(id: string): RegistryReview | undefined {
    const review = this.reviews.get(id);
    return review === undefined ? undefined : structuredClone(review);
  }

  listReviews(): RegistryReview[] {
    return [...this.reviews.values()].map((review) => structuredClone(review));
  }

  putReview(review: RegistryReview): void {
    if (!REVIEW_ID_REGEX.test(review.id)) {
      throw new Error(`review id ${JSON.stringify(review.id)} is not filename-safe`);
    }
    if (!this.reviews.has(review.id) && this.reviews.size >= this.maxReviews) {
      throw new LayerPushError('registry-full', `registry holds ${this.reviews.size} reviews (cap ${this.maxReviews})`);
    }
    const next = structuredClone(review);
    this.writeAtomic(path.join(this.reviewsDir, `${review.id}.json`), JSON.stringify(next));
    this.reviews.set(review.id, next);
  }

  putReport(digest: string, bytes: Uint8Array): string {
    assertReportDigest(digest, bytes); // also pins the blake3:<hex> shape (no traversal)
    const target = path.join(this.reportsDir, digest.slice('blake3:'.length));
    // Content-addressed and digest-verified, so a re-put is idempotent by
    // construction; keep the first write.
    if (fs.existsSync(target)) return digest;
    if (this.reportCount >= this.maxReports) {
      throw new LayerPushError('registry-full', `registry holds ${this.reportCount} reports (cap ${this.maxReports})`);
    }
    this.writeAtomic(target, bytes);
    this.reportCount += 1;
    return digest;
  }

  getReport(digest: string): Uint8Array | undefined {
    const m = LAYER_ID_REGEX.exec(digest);
    if (!m) return undefined;
    try {
      return new Uint8Array(fs.readFileSync(path.join(this.reportsDir, m[1])));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }
}
