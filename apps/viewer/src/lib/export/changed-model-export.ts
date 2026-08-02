/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Real per-model export implementations for the Export Changes flow, plus the
 * production `BuildArtifactsDeps` wiring. Kept out of `model-changes.ts` so that
 * module (and its unit tests) stay free of the browser renderer and the store
 * barrel — the pure `buildChangedArtifacts` takes these as injected deps.
 *
 * Both paths bake the model's pending edits (`applyMutations: true`,
 * `includeGeometry: true`) so the output is a full, round-trippable model with
 * changes applied — not a delta. The STEP path additionally splices any pending
 * schedule, but ONLY when handed real schedule state (the caller passes `null`
 * for every non-target model), which is the sole guard against injecting the
 * single global schedule into every exported file.
 */

import { StepExporter, Ifc5Exporter } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { spliceScheduleIntoExport } from '@/sdk/adapters/export-schedule-splice';
import { ensureModelExportReady } from '@/services/desktop-export';
import type {
  BuildArtifactsDeps,
  ChangesExportArtifact,
  IfcxExportInvocation,
  StepExportInvocation,
} from './model-changes.js';

/**
 * Export one model to STEP with its property/quantity/attribute/georef edits
 * applied, then splice the pending schedule when `invocation.scheduleState` is
 * non-null. Mirrors the single-model STEP branch of `ExportDialog`.
 */
export async function exportChangedModelToStep(
  modelId: string,
  dataStore: IfcDataStore,
  view: MutablePropertyView | undefined,
  invocation: StepExportInvocation,
): Promise<ChangesExportArtifact> {
  const exporter = new StepExporter(dataStore, view);
  const result = await exporter.exportAsync({
    schema: invocation.schema,
    includeGeometry: true,
    applyMutations: true,
    visibleOnly: false,
    georefMutations: invocation.georefMutations,
    description: invocation.description,
    application: 'ifc-lite',
  });

  let content: string | Uint8Array = result.content;
  if (invocation.scheduleState) {
    content = spliceScheduleIntoExport({ content }, modelId, dataStore, invocation.scheduleState).content;
  }

  return { content, ext: 'ifc', mime: 'text/plain' };
}

/**
 * Export one IFC5 model to IFCX with edits applied. Mirrors the (non
 * changes-only) IFC5 branch of `ExportDialog`, including materializing
 * GPU-instanced occurrences for the primary model. `withInstancedMeshes` is
 * dynamically imported so this module can be pulled into a Node test context
 * without loading the browser renderer.
 */
export async function exportChangedModelToIfcx(
  _modelId: string,
  dataStore: IfcDataStore,
  view: MutablePropertyView | undefined,
  invocation: IfcxExportInvocation,
): Promise<ChangesExportArtifact> {
  const { withInstancedMeshes } = await import('../../utils/instancedExport.js');
  const exportGeometry = invocation.geometryResult
    ? withInstancedMeshes(invocation.geometryResult, invocation.idOffset === 0)
    : invocation.geometryResult;

  const exporter = new Ifc5Exporter(dataStore, exportGeometry, view, invocation.idOffset);
  const result = exporter.export({
    includeGeometry: true,
    includeProperties: true,
    applyMutations: true,
    visibleOnly: false,
    // A round-trip "export my edits" should not silently drop properties that
    // lack an official IFC5 schema, so keep full fidelity here. (The Export
    // dialog exposes this as a user toggle that defaults to on; the one-click
    // changes button deliberately favors completeness.)
    onlyKnownProperties: false,
    author: 'ifc-lite',
  });

  return { content: result.content, ext: 'ifcx', mime: 'application/json' };
}

/** Production dependency set for `buildChangedArtifacts`. */
export const defaultBuildArtifactsDeps: BuildArtifactsDeps = {
  resolveStepDataStore: ensureModelExportReady,
  exportStep: exportChangedModelToStep,
  exportIfcx: exportChangedModelToIfcx,
};
