/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Storey authoring in a parsed model (#9013): one path for the viewer, `bim.store`, MCP and CLI. */

export {
  readStoreyInventory, summarizeStoreys, storeyContents, storeySpacingAbove,
  type StoreyInventory, type StoreyRecord, type StoreySummary,
} from './storey-model.js';
export { addStoreyInStore, addStoreyRefusal, renameStoreyInStore, type AddStoreyParams, type AddStoreyResult } from './storey-add.js';
export {
  planStoreyLevelEdit,
  type StoreyLevelEdit, type StoreyLevelPlan, type StoreyMove, type SpacingChange, type PlacementWrite,
} from './storey-level-plan.js';
export { applyStoreyLevelEdit, storeyLevelPlanSignature, type StoreyLevelResult } from './storey-level-apply.js';
export { planStoreyDelete, applyStoreyDelete, type StoreyDeleteMode, type StoreyDeletePlan } from './storey-delete.js';
export { suggestStorey, DEFAULT_STOREY_HEIGHT, type StoreySuggestion } from './storey-suggest.js';
export {
  MIN_STOREY_SPACING, StoreyEditRefusedError, describeElevation,
  type StoreyRefusal, type StoreyRefusalCode, type StoreyNotice,
} from './storey-validation.js';
