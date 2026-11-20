/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared STEP source resolution for geometry exports (USD, Rhino, CityJSON), including
 * dialog and command-palette callers. CityJSON also writes session georeferencing
 * edits through {@link resolveStepExportSource}. Pending edits are regenerated, and ZIP
 * containers use their parsed STEP payload rather than the raw archive.
 */

import { isGeorefRefusal, StepExporter, type StepExportOptions } from '@ifc-lite/export';
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

/** Session georeferencing edits for one model (the store's `georefMutations` entry). */
export type StepExportGeorefMutations = NonNullable<StepExportOptions['georefMutations']>;

/** Whether `gm` carries any edited field. */
export function hasGeorefEdits(gm: StepExportGeorefMutations | undefined): gm is StepExportGeorefMutations {
  return !!gm && (Object.keys(gm.mapConversion ?? {}).length > 0 || Object.keys(gm.projectedCRS ?? {}).length > 0);
}

const SESSION_GEOREF_NOT_WRITTEN = 'Session georeferencing edits were not written; the export uses the file\'s own georeferencing or local coordinates.';

/**
 * Whether {@link resolveStepExportSource} writes session georeferencing edits for `model`: it needs a
 * regenerable STEP store, and IFC2X3 has no IfcProjectedCRS/IfcMapConversion to write them into.
 */
export function writesSessionGeoref(model: StepExportModel): model is StepExportModel & { ifcDataStore: IfcDataStore } {
  const store = model.ifcDataStore;
  return !!store && store.source.byteLength > 0 && store.sourceKind !== 'tabular'
    && model.schemaVersion !== 'IFC5' && model.schemaVersion !== 'IFC2X3';
}

/**
 * The STEP bytes to feed the STEP geometry pipeline for `model`, in order of
 * preference:
 *  1. regenerate when there are edits to write: the mutation view's (so
 *     in-editor authoring, e.g. Room tool spaces, is reflected; shared with
 *     energy-model/STEP export via {@link resolveEnergyExportMutationSource})
 *     and the session's georeferencing edits, written exactly as the IFC
 *     export writes them so an exporter that reads its CRS and map conversion
 *     from the bytes sees the effective georeferencing;
 *  2. else the parsed store bytes (`ifcDataStore.source`), already the
 *     UNWRAPPED STEP payload, so an `.ifczip` model exports correctly instead
 *     of handing the raw ZIP container to the STEP-byte exporter;
 *  3. else the source file bytes, unwrapping ZIP containers (store-less fallback).
 * `warnings` lists session georeferencing edits that were refused or written only in part.
 */
export async function resolveStepExportSource(
  model: StepExportModel,
  getMutationView: (modelId: string) => MutablePropertyView | null,
  georefMutations?: StepExportGeorefMutations,
): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const view = getMutationView(model.id);
  const regenerate = (store: IfcDataStore, georef?: StepExportGeorefMutations) => new StepExporter(store, view ?? undefined).export({
    schema: store.schemaVersion,
    ...(georef ? { georefMutations: georef } : {}),
  });
  // Georeferencing edits live outside the mutation view, so they regenerate on their own. The exporter
  // throws on edits it cannot write (a partial position, IFC2X3); the export then goes ahead without them.
  const warnings: string[] = [];
  if (hasGeorefEdits(georefMutations)) {
    if (!writesSessionGeoref(model)) warnings.push(SESSION_GEOREF_NOT_WRITTEN);
    else {
      try {
        const result = regenerate(model.ifcDataStore, georefMutations);
        return { bytes: result.content, warnings: result.stats.georeferencingWarnings ?? [] };
      } catch (error) {
        if (!isGeorefRefusal(error)) throw error;
        warnings.push(`${SESSION_GEOREF_NOT_WRITTEN} ${error.message}`);
      }
    }
  }
  const mutationSource = resolveEnergyExportMutationSource({ mutationView: view, dataStore: model.ifcDataStore, schemaVersion: model.schemaVersion });
  return { bytes: mutationSource ? regenerate(mutationSource.dataStore).content : await rawStepBytes(model), warnings };
}

/** {@link resolveStepExportSource} without session georeferencing, bytes only. */
export async function resolveStepExportBytes(
  model: StepExportModel,
  getMutationView: (modelId: string) => MutablePropertyView | null,
): Promise<Uint8Array> {
  return (await resolveStepExportSource(model, getMutationView)).bytes;
}

async function rawStepBytes(model: StepExportModel): Promise<Uint8Array> {
  if (model.ifcDataStore && model.ifcDataStore.source.byteLength > 0) {
    // Whole-file consumer: geometry export re-reads the raw STEP.
    return model.ifcDataStore.source.materialize();
  }
  return new Uint8Array(await unwrapIfcZip(await model.sourceFile.arrayBuffer()));
}
