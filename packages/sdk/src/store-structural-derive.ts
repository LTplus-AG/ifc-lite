/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store.planStructuralDerivation` / `deriveStructuralAnalysisModel`:
 * derive an analytical model from the physical one in the same file (#9668).
 * The rules live in `@ifc-lite/create`'s `structural-derive-types.ts`; this
 * module only resolves the model and calls the three steps.
 */

import {
  applyStructuralDerivation,
  planStructuralDerivation,
  readStructuralDerivationFacts,
  type StructuralDerivationOptions,
  type StructuralDerivationPlan,
  type StructuralDerivationReport,
} from '@ifc-lite/create';
import type { StructuralStoreModelResolver } from './store-structural-backend.js';
import type { EntityRef } from './types.js';

export interface StructuralDerivationResult {
  /** The new IfcStructuralAnalysisModel. */
  analysisModel: EntityRef;
  report: StructuralDerivationReport;
}

export interface StructuralDerivationStoreBackendMethods {
  /** Read the physical model and plan the analytical one. Writes nothing. Optional capability. */
  planStructuralDerivation?(modelId: string, options?: StructuralDerivationOptions): StructuralDerivationPlan;
  /** Plan and write one IfcStructuralAnalysisModel. Refuses when there is nothing to derive. Optional capability. */
  deriveStructuralAnalysisModel?(modelId: string, options?: StructuralDerivationOptions): StructuralDerivationResult;
}

export function createStructuralDerivationStoreBackend(
  resolve: StructuralStoreModelResolver,
): Required<StructuralDerivationStoreBackendMethods> {
  const plan = (modelId: string, options?: StructuralDerivationOptions) => {
    const model = resolve(modelId);
    return { model, plan: planStructuralDerivation(readStructuralDerivationFacts(model.store, model.editor), options) };
  };
  return {
    planStructuralDerivation: (modelId, options) => plan(modelId, options).plan,
    deriveStructuralAnalysisModel(modelId, options) {
      const { model, plan: derived } = plan(modelId, options);
      const { analysisModelId } = applyStructuralDerivation(model.editor, model.store, derived);
      return { analysisModel: { modelId: model.modelId, expressId: analysisModelId }, report: derived.report };
    },
  };
}
