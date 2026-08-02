/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-local layer store (#1717 V2): the CLI's `.ifc-lite/` layout on
 * IndexedDB — content-addressed layers plus a named-ref record.
 *
 * `@ifc-lite/merge` consumes the SYNC `LayerRefStore` interface, so the
 * working state lives in memory and IndexedDB is a write-through mirror:
 * `open()` hydrates once, every mutation persists fire-and-forget (a
 * failed write logs and keeps the session working; the durable copy just
 * lags). Layers are immutable and first-write-wins per content address,
 * mirroring the registry semantics.
 */

import { computeLayerId } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import type { LayerRefStore, RefEntry } from '@ifc-lite/merge';

const DB_NAME = 'ifc-lite-layer-store';
const DB_VERSION = 1;
const LAYERS = 'layers';
const REFS = 'refs';

/** The ref local publishes land on when the user never picked one. */
export const DEFAULT_LOCAL_REF = 'local';

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LAYERS)) db.createObjectStore(LAYERS);
      if (!db.objectStoreNames.contains(REFS)) db.createObjectStore(REFS);
    };
    req.onsuccess = () => resolve(req.result);
    // A blocked/broken IDB (private mode, quota) degrades to memory-only.
    req.onerror = () => {
      console.warn('[layer-store] IndexedDB unavailable, layers will not persist:', req.error);
      resolve(null);
    };
  });
}

function readAll<T>(db: IDBDatabase, storeName: string): Promise<Map<string, T>> {
  return new Promise((resolve) => {
    const out = new Map<string, T>();
    const tx = db.transaction(storeName, 'readonly');
    const cursorReq = tx.objectStore(storeName).openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      out.set(String(cursor.key), cursor.value as T);
      cursor.continue();
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => resolve(out);
  });
}

export class BrowserLayerStore implements LayerRefStore {
  private readonly layers = new Map<string, IfcxFile>();
  private readonly refs = new Map<string, RefEntry>();
  private readonly db: IDBDatabase | null;

  private constructor(db: IDBDatabase | null) {
    this.db = db;
  }

  /** Hydrate the working state from IndexedDB (memory-only without it). */
  static async open(): Promise<BrowserLayerStore> {
    const db = await openDatabase();
    const store = new BrowserLayerStore(db);
    if (db) {
      const [layers, refs] = await Promise.all([
        readAll<IfcxFile>(db, LAYERS),
        readAll<RefEntry>(db, REFS),
      ]);
      for (const [id, file] of layers) store.layers.set(id, file);
      for (const [name, entry] of refs) store.refs.set(name, entry);
    }
    return store;
  }

  private persist(storeName: string, key: string, value: unknown): void {
    if (!this.db) return;
    try {
      const tx = this.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(structuredClone(value), key);
      tx.onerror = () => console.warn(`[layer-store] persist ${storeName}/${key} failed:`, tx.error);
    } catch (err) {
      console.warn(`[layer-store] persist ${storeName}/${key} failed:`, err);
    }
  }

  /** Verify the content address, then store (first write wins, idempotent). */
  storeLayer(file: IfcxFile): string {
    const computed = computeLayerId(file);
    if (file.header.id !== computed) {
      throw new Error(`layer header.id ${file.header.id} does not match content address ${computed}`);
    }
    const existing = this.layers.get(computed);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(file)) {
        throw new Error(`layer ${computed} already stored with different bytes; refusing overwrite`);
      }
      return computed;
    }
    this.layers.set(computed, structuredClone(file));
    this.persist(LAYERS, computed, file);
    return computed;
  }

  loadLayer(layerId: string): IfcxFile {
    const file = this.layers.get(layerId);
    if (!file) throw new Error(`No layer ${layerId} in the local store`);
    return structuredClone(file);
  }

  hasLayer(layerId: string): boolean {
    return this.layers.has(layerId);
  }

  listLayers(): string[] {
    return [...this.layers.keys()];
  }

  getRef(name: string): RefEntry | undefined {
    const entry = this.refs.get(name);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  setRef(name: string, entry: RefEntry): void {
    const clean: RefEntry = { layers: [...entry.layers], ...(entry.policy ? { policy: entry.policy } : {}) };
    this.refs.set(name, structuredClone(clean));
    this.persist(REFS, name, clean);
  }

  listRefs(): Record<string, RefEntry> {
    return Object.fromEntries([...this.refs.entries()].map(([name, entry]) => [name, structuredClone(entry)]));
  }
}

let singleton: Promise<BrowserLayerStore> | null = null;

/** The app-wide local layer store, opened lazily once per session. */
export function getBrowserLayerStore(): Promise<BrowserLayerStore> {
  singleton ??= BrowserLayerStore.open();
  return singleton;
}
