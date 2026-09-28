/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GeometryProcessor, type ExtrusionDefinitions } from '@ifc-lite/geometry';
import { sourceIdentity, withAnalyticSource, type AnalyticSourceModel } from './swept-disk-cache';

type Instance = ExtrusionDefinitions['instances'][number][number];
type Definition = ExtrusionDefinitions['sources'][number];

export interface ProductExtrusions {
  occurrences: { instance: Instance; definition: Definition | null }[];
  diagnostics: string[];
  lengthUnitScale: number;
}

interface Entry {
  source: object;
  products: Map<number, ProductExtrusions>;
  inFlight: Promise<void> | null;
}

/** Selected-product source records, keyed by the retained IFC source identity. */
export class ExtrusionCache {
  private readonly entries = new Map<string, Entry>();
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
        console.error('[ifc-lite] Could not release extrusion decoder', error);
      });
    };
  }

  prune(models: Iterable<AnalyticSourceModel>): void {
    const live = new Map([...models].map((model) => [model.id, sourceIdentity(model)]));
    for (const [id, entry] of this.entries) {
      if (live.get(id) !== entry.source) this.entries.delete(id);
    }
  }

  async get(model: AnalyticSourceModel, ids: readonly number[]): Promise<Map<number, ProductExtrusions>> {
    const source = sourceIdentity(model);
    if (!source) throw new Error(`model ${model.id} has no retained IFC source`);
    let entry = this.entries.get(model.id);
    if (!entry || entry.source !== source) {
      entry = { source, products: new Map(), inFlight: null };
      this.entries.set(model.id, entry);
    }
    const epoch = this.epoch;
    while (entry.inFlight) await entry.inFlight;
    if (this.epoch !== epoch || this.users === 0 || this.entries.get(model.id) !== entry) return new Map();
    const missing = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0 && !entry.products.has(id));
    if (missing.length > 0) {
      const active = entry;
      const batch = this.extract(model, missing).then((result) => {
        if (this.epoch !== epoch || this.entries.get(model.id) !== active) return;
        // The source key includes representation context, not just a solid ID.
        const sources = new Map(result.sources.map((definition) => [JSON.stringify(definition.key), definition]));
        const diagnosticsById = new Map<number, string[]>();
        for (const message of result.diagnostics) {
          const id = Number(/^product #(\d+)[:,]/.exec(message)?.[1]);
          if (!id) continue;
          const messages = diagnosticsById.get(id) ?? [];
          messages.push(message);
          diagnosticsById.set(id, messages);
        }
        for (const id of missing) {
          active.products.set(id, {
            occurrences: (result.instances[id] ?? []).map((instance) => ({
              instance, definition: sources.get(JSON.stringify(instance.source)) ?? null,
            })),
            diagnostics: diagnosticsById.get(id) ?? [],
            lengthUnitScale: result.length_unit_scale,
          });
        }
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

  private async ready(): Promise<GeometryProcessor> {
    if (!this.initialization) {
      const processor = new GeometryProcessor({ preferNative: false });
      const initialization = processor.init().then(() => processor);
      this.initialization = initialization;
      void initialization.catch((error: unknown) => {
        if (this.initialization === initialization) this.initialization = null;
        processor.dispose();
        console.error('[ifc-lite] Could not initialize extrusion decoder', error);
      });
    }
    return this.initialization;
  }

  protected async extract(model: AnalyticSourceModel, ids: readonly number[]): Promise<ExtrusionDefinitions> {
    const processor = await this.ready();
    const result = await withAnalyticSource(model,
      (bytes) => processor.extractExtrusionDefinitions(bytes, new Uint32Array(ids)));
    if (!result) throw new Error(`model ${model.id} has no usable IFC source or analytic decoder`);
    return result;
  }
}

export const selectedExtrusionCache = new ExtrusionCache();
