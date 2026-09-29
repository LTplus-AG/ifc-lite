/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ExtrusionDefinitions } from '@ifc-lite/geometry';
import { AnalyticProductCache, diagnosticsByProductId, withAnalyticSource, type AnalyticSourceModel } from './analytic-product-cache';

type Instance = ExtrusionDefinitions['instances'][number][number];
type Definition = ExtrusionDefinitions['sources'][number];

export interface ProductExtrusions {
  occurrences: { instance: Instance; definition: Definition | null }[];
  diagnostics: string[];
  lengthUnitScale: number;
}

/** Selected-product source records, keyed by the retained IFC source identity. */
export class ExtrusionCache extends AnalyticProductCache<ExtrusionDefinitions, ProductExtrusions> {
  protected override async extract(model: AnalyticSourceModel, ids: readonly number[]): Promise<ExtrusionDefinitions> {
    const processor = await this.ready();
    const result = await withAnalyticSource(model,
      (bytes) => processor.extractExtrusionDefinitions(bytes, new Uint32Array(ids)));
    if (!result) throw new Error(`model ${model.id} has no usable IFC source or analytic decoder`);
    return result;
  }

  protected override products(result: ExtrusionDefinitions, ids: readonly number[]): Map<number, ProductExtrusions> {
    // The source key includes representation context, not just a solid ID.
    const sources = new Map(result.sources.map((definition) => [JSON.stringify(definition.key), definition]));
    const diagnosticsById = diagnosticsByProductId(result.diagnostics);
    return new Map(ids.map((id) => [id, {
      occurrences: (result.instances[id] ?? []).map((instance) => ({
        instance, definition: sources.get(JSON.stringify(instance.source)) ?? null,
      })),
      diagnostics: diagnosticsById.get(String(id)) ?? [],
      lengthUnitScale: result.length_unit_scale,
    }]));
  }
}

export const selectedExtrusionCache = new ExtrusionCache();
