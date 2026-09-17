/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BimBackend, EntityRef } from '../types.js';
import type { CostEvaluationOptions, CostReadOptions } from '../cost-types.js';

/**
 * Read-only 5D cost data for a loaded model.
 *
 * Reads observe the model's PENDING edits by default (#4857), so what
 * `bim.cost` reports and what `bim.export.ifc()` writes describe the same
 * file. Pass `{ includeMutations: false }` for the graph as the file on disk
 * states it — not an empty graph, and not an error.
 */
export class CostNamespace {
  constructor(private backend: BimBackend) {}
  private methods() { const value = this.backend.cost; if (!value) throw new Error('bim.cost is not supported by this backend'); return value; }
  data(modelId?: string, options?: CostReadOptions) { return this.methods().data(modelId, options); }
  schedules(modelId?: string, options?: CostReadOptions) { return this.methods().schedules(modelId, options); }
  items(modelId?: string, options?: CostReadOptions) { return this.methods().items(modelId, options); }
  values(modelId?: string, options?: CostReadOptions) { return this.methods().values(modelId, options); }
  evaluateItem(ref: EntityRef, options?: CostEvaluationOptions & CostReadOptions) { return this.methods().evaluateItem(ref, options); }
  evaluateValue(ref: EntityRef, options?: CostEvaluationOptions & CostReadOptions) { return this.methods().evaluateValue(ref, options); }
}
