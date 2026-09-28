/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GeometryProcessor, type SweptDiskDescriptions } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';

type Occurrences = SweptDiskDescriptions['elements'][string];

export interface AnalyticSourceModel {
  id: string;
  ifcDataStore: IfcDataStore | null;
  sourceFile?: File;
}

export interface ProductSweptDisks {
  occurrences: Occurrences;
  diagnostics: string[];
}

interface ModelEntry {
  source: object;
  products: Map<number, ProductSweptDisks>;
  inFlight: Promise<void> | null;
}

/** One opt-in decoder shared by viewer overlays and inspection. */
export class SweptDiskCache {
  private readonly entries = new Map<string, ModelEntry>();
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

  /** Drop removed or replaced model sources without touching other model caches. */
  prune(models: Iterable<AnalyticSourceModel>): void {
    const live = new Map([...models].map((model) => [model.id, sourceIdentity(model)]));
    for (const [id, entry] of this.entries) {
      if (live.get(id) !== entry.source) this.entries.delete(id);
    }
  }

  async get(model: AnalyticSourceModel, ids: readonly number[]): Promise<Map<number, ProductSweptDisks>> {
    const source = sourceIdentity(model);
    if (!source) throw new Error(`model ${model.id} has no retained IFC source`);
    let entry = this.entries.get(model.id);
    if (!entry || entry.source !== source) {
      entry = { source, products: new Map(), inFlight: null };
      this.entries.set(model.id, entry);
    }
    const epoch = this.epoch;
    // One model's overlapping selections share a serial batch. A second caller
    // rechecks the per-product cache when the first batch finishes.
    while (entry.inFlight) await entry.inFlight;
    if (this.epoch !== epoch || this.users === 0 || this.entries.get(model.id) !== entry) return new Map();
    const missing = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0 && !entry.products.has(id));
    if (missing.length > 0) {
      const active = entry;
      const batch = this.extract(model, missing).then((result) => {
        if (this.epoch !== epoch || this.entries.get(model.id) !== active) return;
        const diagnosticsById = new Map<string, string[]>();
        for (const message of result.diagnostics) {
          const product = /^product #(\d+)[:,]/.exec(message)?.[1];
          if (!product) continue;
          const diagnostics = diagnosticsById.get(product) ?? [];
          diagnostics.push(message);
          diagnosticsById.set(product, diagnostics);
        }
        for (const id of missing) {
          active.products.set(id, {
            occurrences: result.elements[String(id)] ?? [],
            diagnostics: diagnosticsById.get(String(id)) ?? [],
          });
        }
      });
      entry.inFlight = batch;
      try { await batch; }
      finally { if (entry.inFlight === batch) entry.inFlight = null; }
    }
    return new Map(ids.flatMap((id) => {
      const value = entry.products.get(id);
      return value ? [[id, value] as const] : [];
    }));
  }

  private async ready(): Promise<GeometryProcessor> {
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

  protected async extract(model: AnalyticSourceModel, ids: readonly number[]): Promise<SweptDiskDescriptions> {
    const processor = await this.ready();
    const extract = (bytes: Uint8Array) => processor.extractSweptDiskDescriptions(bytes, new Uint32Array(ids));
    const storeSource = model.ifcDataStore?.source;
    const result = storeSource && storeSource.byteLength > 0
      ? await storeSource.withMaterializedAsync(async (bytes) => extract(bytes))
      : model.sourceFile ? extract(new Uint8Array(await model.sourceFile.arrayBuffer())) : null;
    if (!result) throw new Error(`model ${model.id} has no usable IFC source or analytic decoder`);
    return result;
  }
}

export function sourceIdentity(model: AnalyticSourceModel): object | null {
  const store = model.ifcDataStore;
  return store?.source.byteLength ? store.source : model.sourceFile ?? null;
}

export const selectedSweptDiskCache = new SweptDiskCache();
