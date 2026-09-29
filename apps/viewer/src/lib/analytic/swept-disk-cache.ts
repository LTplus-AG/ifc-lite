/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type SweptDiskDescriptions } from '@ifc-lite/geometry';
import { AnalyticProductCache, diagnosticsByProductId, withAnalyticSource, type AnalyticSourceModel } from './analytic-product-cache';

export { sourceIdentity, withAnalyticSource, type AnalyticSourceModel } from './analytic-product-cache';

type Occurrences = SweptDiskDescriptions['elements'][string];

export interface ProductSweptDisks {
  occurrences: Occurrences;
  diagnostics: string[];
}

/** One opt-in decoder shared by viewer overlays and inspection. */
export class SweptDiskCache extends AnalyticProductCache<SweptDiskDescriptions, ProductSweptDisks> {
  protected override async extract(model: AnalyticSourceModel, ids: readonly number[]): Promise<SweptDiskDescriptions> {
    const processor = await this.ready();
    const result = await withAnalyticSource(model,
      (bytes) => processor.extractSweptDiskDescriptions(bytes, new Uint32Array(ids)));
    if (!result) throw new Error(`model ${model.id} has no usable IFC source or analytic decoder`);
    return result;
  }

  protected override products(result: SweptDiskDescriptions, ids: readonly number[]): Map<number, ProductSweptDisks> {
    const diagnosticsById = diagnosticsByProductId(result.diagnostics);
    return new Map(ids.map((id) => [id, {
      occurrences: result.elements[String(id)] ?? [],
      diagnostics: diagnosticsById.get(String(id)) ?? [],
    }]));
  }
}

export const selectedSweptDiskCache = new SweptDiskCache();
