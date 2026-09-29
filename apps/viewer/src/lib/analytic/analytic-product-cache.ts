/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GeometryProcessor } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';

export interface AnalyticSourceModel {
  id: string;
  ifcDataStore: IfcDataStore | null;
  sourceFile?: File;
}

interface Entry<T> {
  source: object;
  products: Map<number, T>;
  inFlight: Promise<void> | null;
}

/** Shared lifetime and per-source batching for opt-in analytic inspection. */
export abstract class AnalyticProductCache<Result, Product> {
  private readonly entries = new Map<string, Entry<Product>>();
  private initialization: Promise<GeometryProcessor> | null = null;
  private users = 0;
  private epoch = 0;

  retain(): () => void {
    this.users++;
    return () => {
      if (--this.users !== 0) return;
      this.epoch++;
      this.entries.clear();
      const pending = this.initialization;
      this.initialization = null;
      if (pending) void pending.then((processor) => processor.dispose()).catch((error: unknown) => {
        console.error('[ifc-lite] Could not release analytic geometry decoder', error);
      });
    };
  }

  prune(models: Iterable<AnalyticSourceModel>): void {
    const live = new Map([...models].map((model) => [model.id, sourceIdentity(model)]));
    for (const [id, entry] of this.entries) {
      if (live.get(id) !== entry.source) this.entries.delete(id);
    }
  }

  async get(model: AnalyticSourceModel, ids: readonly number[]): Promise<Map<number, Product>> {
    const source = sourceIdentity(model);
    if (!source) throw new Error(`model ${model.id} has no retained IFC source`);
    let entry = this.entries.get(model.id);
    if (!entry || entry.source !== source) {
      entry = { source, products: new Map(), inFlight: null };
      this.entries.set(model.id, entry);
    }
    const epoch = this.epoch;
    // Overlapping selections of one model share a serial batch. Later callers
    // recheck the product cache after that batch completes.
    while (entry.inFlight) await entry.inFlight;
    if (this.epoch !== epoch || this.users === 0 || this.entries.get(model.id) !== entry) return new Map();
    const missing = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0 && !entry.products.has(id));
    if (missing.length > 0) {
      const active = entry;
      const batch = this.extract(model, missing).then((result) => {
        if (this.epoch !== epoch || this.entries.get(model.id) !== active) return;
        for (const [id, product] of this.products(result, missing)) active.products.set(id, product);
      });
      entry.inFlight = batch;
      try { await batch; }
      finally { if (entry.inFlight === batch) entry.inFlight = null; }
    }
    return new Map(ids.flatMap((id) => {
      const product = entry.products.get(id);
      return product ? [[id, product] as const] : [];
    }));
  }

  protected async ready(): Promise<GeometryProcessor> {
    if (!this.initialization) {
      const processor = new GeometryProcessor({ preferNative: false });
      const initialization = processor.init().then(() => processor);
      this.initialization = initialization;
      void initialization.catch((error: unknown) => {
        if (this.initialization === initialization) this.initialization = null;
        processor.dispose();
        console.error('[ifc-lite] Could not initialize analytic geometry decoder', error);
      });
    }
    return this.initialization;
  }

  protected abstract extract(model: AnalyticSourceModel, ids: readonly number[]): Promise<Result>;
  protected abstract products(result: Result, ids: readonly number[]): Map<number, Product>;
}

export function sourceIdentity(model: AnalyticSourceModel): object | null {
  const store = model.ifcDataStore;
  return store?.source?.byteLength ? store.source : model.sourceFile ?? null;
}

/** Route source diagnostics by the product ID printed by the decoder. */
export function diagnosticsByProductId(messages: readonly string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const message of messages) {
    const id = /^product #(\d+)[:,]/.exec(message)?.[1];
    if (id === undefined) continue;
    const productMessages = grouped.get(id) ?? [];
    productMessages.push(message);
    grouped.set(id, productMessages);
  }
  return grouped;
}

/** Read the source retained by the canonical model load path, including spill storage. */
export async function withAnalyticSource<T>(
  model: AnalyticSourceModel, extract: (bytes: Uint8Array) => T | Promise<T>,
): Promise<T | null> {
  const source = model.ifcDataStore?.source;
  if (source && source.byteLength > 0) return source.withMaterializedAsync(async (bytes) => extract(bytes));
  return model.sourceFile ? extract(new Uint8Array(await model.sourceFile.arrayBuffer())) : null;
}
