/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BimBackend, EntityRef } from '../types.js';
import type { CostEvaluationOptions } from '../cost-types.js';

/** Read-only 5D cost data from the loaded IFC source snapshot. */
export class CostNamespace {
  constructor(private backend: BimBackend) {}
  private methods() { const value = this.backend.cost; if (!value) throw new Error('bim.cost is not supported by this backend'); return value; }
  data(modelId?: string) { return this.methods().data(modelId); }
  schedules(modelId?: string) { return this.methods().schedules(modelId); }
  items(modelId?: string) { return this.methods().items(modelId); }
  values(modelId?: string) { return this.methods().values(modelId); }
  evaluateItem(ref: EntityRef, options?: CostEvaluationOptions) { return this.methods().evaluateItem(ref, options); }
  evaluateValue(ref: EntityRef, options?: CostEvaluationOptions) { return this.methods().evaluateValue(ref, options); }
}
