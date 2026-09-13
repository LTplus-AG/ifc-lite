/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bim.structural — read-only access to IFC structural analysis data.
 *
 * Mirrors the data the parser's `extractStructuralOnDemand` produces:
 *   • `data()`            — the full extraction (analysis models, members,
 *                            connections, activities, load groups, result
 *                            groups) plus `loadsTruncated`
 *   • `analysisModels()`  — IfcStructuralAnalysisModel containers
 *   • `members()`         — IfcStructuralMember subtype occurrences
 *   • `connections()`     — IfcStructuralConnection subtype occurrences
 *   • `activities()`      — IfcStructuralActivity subtype occurrences (actions + reactions)
 *   • `loadGroups()`      — IfcStructuralLoadGroup / IfcStructuralLoadCase
 *   • `resultGroups()`    — IfcStructuralResultGroup
 *
 * `data().loadsTruncated` must be read by any caller that reports a load
 * count or tree as complete: it is true when reading an activity's applied
 * load hit a reader bound (nesting depth, node budget, or a cycle guard)
 * rather than running out of data the file actually holds. This namespace
 * does not compute that flag — it forwards exactly what the backend
 * extraction reports, so the bound is visible at this layer too, not
 * silently dropped between the extractor and the caller.
 *
 * The `modelId` argument is optional. When omitted, the active model is used.
 */

import type {
  BimBackend,
  StructuralExtractionData,
  StructuralAnalysisModelData,
  StructuralMemberData,
  StructuralConnectionData,
  StructuralActivityData,
  StructuralLoadGroupData,
  StructuralResultGroupData,
} from '../types.js';

export class StructuralNamespace {
  constructor(private backend: BimBackend) {}

  /** Full structural extraction for the active (or specified) model. */
  data(modelId?: string): StructuralExtractionData {
    return this.backend.structural.data(modelId);
  }

  /** All IfcStructuralAnalysisModel containers. */
  analysisModels(modelId?: string): StructuralAnalysisModelData[] {
    return this.backend.structural.analysisModels(modelId);
  }

  /** All IfcStructuralMember subtype occurrences. */
  members(modelId?: string): StructuralMemberData[] {
    return this.backend.structural.members(modelId);
  }

  /** All IfcStructuralConnection subtype occurrences. */
  connections(modelId?: string): StructuralConnectionData[] {
    return this.backend.structural.connections(modelId);
  }

  /** All IfcStructuralActivity subtype occurrences (actions and reactions). */
  activities(modelId?: string): StructuralActivityData[] {
    return this.backend.structural.activities(modelId);
  }

  /** All IfcStructuralLoadGroup / IfcStructuralLoadCase entities. */
  loadGroups(modelId?: string): StructuralLoadGroupData[] {
    return this.backend.structural.loadGroups(modelId);
  }

  /** All IfcStructuralResultGroup entities. */
  resultGroups(modelId?: string): StructuralResultGroupData[] {
    return this.backend.structural.resultGroups(modelId);
  }
}
