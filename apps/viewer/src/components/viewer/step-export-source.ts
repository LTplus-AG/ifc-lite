/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared STEP source resolution for geometry exports (USD and Rhino), including
 * dialog and command-palette callers. Pending edits are regenerated, and ZIP
 * containers use their parsed STEP payload rather than the raw archive.
 */

import { StepExporter } from '@ifc-lite/export';
import { unwrapIfcZip, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel, SchemaVersion } from '@/store/types';
import { resolveEnergyExportMutationSource } from './energy-export-source';

/**
 * IFC models the geometry exporters can consume: geometry-backed STEP sources
 * (`.ifc` / `.ifczip`). `.ifcx` is USD-flavored JSON handled by a separate
 * exporter (`Ifc5Exporter`), not a STEP source the geometry pipeline reads —
 * feeding it to the STEP geometry pipeline yields a silent empty stage, so
 * it is excluded here. Type-narrows `sourceFile` to a present `File`.
 */
export function isStepSourceModel(
  m: FederatedModel,
): m is FederatedModel & { sourceFile: File } {
  return !!m.sourceFile && /\.(ifc|ifczip)$/i.test(m.sourceFile.name);
}

/** The subset of a model the STEP source resolver reads. */
export interface StepExportModel {
  id: string;
  name: string;
  sourceFile: File;
  ifcDataStore: IfcDataStore | null;
  schemaVersion: SchemaVersion;
}

/**
 * The STEP bytes to feed the STEP geometry pipeline for `model`, in order of
 * preference:
 *  1. regenerate through the mutation view when it carries actual edits (so
 *     in-editor authoring — e.g. Room tool spaces — is reflected; shared with
 *     energy-model/STEP export via {@link resolveEnergyExportMutationSource});
 *  2. else the parsed store bytes (`ifcDataStore.source`) — already the
 *     UNWRAPPED STEP payload, so an `.ifczip` model exports correctly instead
 *     of handing the raw ZIP container to the STEP-byte exporter;
 *  3. else the source file bytes, unwrapping ZIP containers (store-less fallback).
 */
export async function resolveStepExportBytes(
  model: StepExportModel,
  getMutationView: (modelId: string) => MutablePropertyView | null,
): Promise<Uint8Array> {
  const mutationSource = resolveEnergyExportMutationSource({
    mutationView: getMutationView(model.id),
    dataStore: model.ifcDataStore,
    schemaVersion: model.schemaVersion,
  });
  if (mutationSource) {
    return new StepExporter(mutationSource.dataStore, mutationSource.mutationView).export({
      schema: mutationSource.dataStore.schemaVersion,
    }).content;
  }
  if (model.ifcDataStore && model.ifcDataStore.source.byteLength > 0) {
    // Whole-file consumer: geometry export re-reads the raw STEP.
    return model.ifcDataStore.source.materialize();
  }
  return new Uint8Array(await unwrapIfcZip(await model.sourceFile.arrayBuffer()));
}
