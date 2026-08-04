/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared source resolution for OpenUSD (`.usda`) export, used by BOTH the
 * `UsdExportDialog` and the command-palette `export:usd` action so they never
 * diverge (an earlier palette path read the raw store bytes directly and so
 * dropped pending edits and mishandled `.ifczip` / `.ifcx`).
 *
 * Split out (like `hbjson-export-source.ts`) so the decision logic is testable
 * without mounting React.
 */

import { StepExporter } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel, SchemaVersion } from '@/store/types';
import { resolveHbjsonMutationSource } from './hbjson-export-source';

/**
 * IFC models the USD exporter can consume: geometry-backed STEP sources
 * (`.ifc` / `.ifczip`). `.ifcx` is USD-*flavored JSON* handled by a separate
 * exporter (`Ifc5Exporter`), not a STEP source the geometry pipeline reads —
 * feeding it to `GeometryProcessor.exportUsd` yields a silent empty stage, so
 * it is excluded here. Type-narrows `sourceFile` to a present `File`.
 */
export function isUsdExportableModel(
  m: FederatedModel,
): m is FederatedModel & { sourceFile: File } {
  return !!m.sourceFile && /\.(ifc|ifczip)$/i.test(m.sourceFile.name);
}

/** The subset of a model the USD source resolver reads. */
export interface UsdExportModel {
  id: string;
  name: string;
  sourceFile: File;
  ifcDataStore: IfcDataStore | null;
  schemaVersion: SchemaVersion;
}

/**
 * The STEP bytes to feed `GeometryProcessor.exportUsd` for `model`, in order of
 * preference:
 *  1. regenerate through the mutation view when it carries actual edits (so
 *     in-editor authoring — e.g. Space Sketch rooms — is reflected; shared with
 *     HBJSON/STEP export via {@link resolveHbjsonMutationSource});
 *  2. else the parsed store bytes (`ifcDataStore.source`) — already the
 *     UNWRAPPED STEP payload, so an `.ifczip` model exports correctly instead
 *     of handing the raw ZIP container to the STEP-byte exporter;
 *  3. else the raw file bytes (rare store-less fallback).
 */
export async function resolveUsdExportBytes(
  model: UsdExportModel,
  getMutationView: (modelId: string) => MutablePropertyView | null,
): Promise<Uint8Array> {
  const mutationSource = resolveHbjsonMutationSource({
    mutationView: getMutationView(model.id),
    dataStore: model.ifcDataStore,
    schemaVersion: model.schemaVersion,
  });
  if (mutationSource) {
    return new StepExporter(mutationSource.dataStore, mutationSource.mutationView).export({
      schema: mutationSource.dataStore.schemaVersion,
    }).content;
  }
  if (model.ifcDataStore?.source) {
    return model.ifcDataStore.source;
  }
  return new Uint8Array(await model.sourceFile.arrayBuffer());
}
