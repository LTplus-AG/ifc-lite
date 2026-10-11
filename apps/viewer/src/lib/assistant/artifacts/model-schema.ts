/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A local, revision-aware index of what the loaded models actually carry:
 * element classes, every property and quantity by exact set and name with the
 * number of elements carrying it (per model), and the chart field catalog the
 * chart editor would offer. Built from the same element population and field
 * reader the Charts `elements` dataset uses (geometry-bearing, non-type rows,
 * effective under live edits), so a count here is the count an engine sees.
 *
 * It is never sent wholesale: the review reads it to check names and rank
 * candidates, and the guidance sends a bounded digest. Cached per federation
 * identity and mutation revision; a model load, unload or edit rebuilds it.
 * Like the chart editor's field discovery, the scan runs in chunks and yields
 * between them (about a second per 15k elements on a real hospital model),
 * so neither a send nor a review blocks the viewer, and a newer revision can
 * abandon a stale scan.
 */

import { EntityFlags } from '@ifc-lite/data';
import type { ViewerState } from '@/store';
import { createElementFieldReader, type ElementFieldCatalog } from '@/lib/charts/element-field-reader';
import { catalogFromObservations, emptyObservations, mergeObservations } from '@/lib/charts/element-field-discovery';
import { iterateEffectiveChartRows } from '@/lib/charts/datasets/effective-elements';
import { fieldKey, type FieldKind } from './field-refs';
import { effectiveClassificationSystems } from '@/components/viewer/properties/effective-classification-systems';

export interface FieldPresence {
  kind: FieldKind;
  set: string;
  name: string;
  /** Elements carrying it (on the occurrence or through its type), across models. */
  count: number;
  byModel: Map<string, number>;
}

export interface SchemaModel { modelId: string; name: string; elements: number; scanned: number }

export interface ModelSchemaIndex {
  models: SchemaModel[];
  /** PascalCase IFC class -> element count across models. */
  classes: Map<string, number>;
  fields: Map<string, FieldPresence>;
  catalog: ElementFieldCatalog;
  /** True when a model held more elements than the scan budget; counts then cover the scanned ones. */
  partial: boolean;
}

/** Elements scanned per model; beyond it counts are labelled partial rather than slowing review. */
export const SCHEMA_SCAN_LIMIT = 50_000;

type SchemaState = Pick<ViewerState, 'models' | 'mutationViews' | 'mutationVersion'>;
const cache = new WeakMap<object, { version: number; index: ModelSchemaIndex }>();
/** Rows scanned between yields, as in the chart editor's field discovery. */
const CHUNK = 500;

/** The index for `state`'s federation and revision; built once, then cached. Rejects with an AbortError when `signal` aborts. */
export async function modelSchemaIndex(state: SchemaState, signal?: AbortSignal): Promise<ModelSchemaIndex> {
  const cached = cache.get(state.models);
  if (cached && cached.version === state.mutationVersion) return cached.index;
  const index = await buildModelSchemaIndex(state, { signal });
  cache.set(state.models, { version: state.mutationVersion, index });
  return index;
}

export async function buildModelSchemaIndex(state: SchemaState, options: { signal?: AbortSignal; chunk?: number } = {}): Promise<ModelSchemaIndex> {
  const { signal, chunk = CHUNK } = options;
  const models: SchemaModel[] = [];
  const classes = new Map<string, number>();
  const fields = new Map<string, FieldPresence>();
  const observations = emptyObservations();
  let partial = false;
  const bump = (kind: FieldKind, set: string, name: string, modelId: string) => {
    const key = fieldKey({ kind, set, name });
    let entry = fields.get(key);
    if (!entry) { entry = { kind, set, name, count: 0, byModel: new Map() }; fields.set(key, entry); }
    entry.count += 1;
    entry.byModel.set(modelId, (entry.byModel.get(modelId) ?? 0) + 1);
  };
  for (const [modelId, model] of state.models) {
    const store = model.ifcDataStore;
    if (!store) continue;
    const view = state.mutationViews.get(modelId);
    const reader = createElementFieldReader(store, view);
    // A declared system with no assignments is valid for native absence queries.
    // Discovery and native evaluation share the effective classification reader (#7131).
    for (const name of effectiveClassificationSystems(store, view).names) {
      const key = fieldKey({ kind: 'classification', set: '', name });
      let entry = fields.get(key);
      if (!entry) { entry = { kind: 'classification', set: '', name, count: 0, byModel: new Map() }; fields.set(key, entry); }
      entry.byModel.set(modelId, 0);
    }
    let elements = 0;
    let scanned = 0;
    let rows = 0;
    for (const row of iterateEffectiveChartRows(store, view)) {
      if (++rows % chunk === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal?.throwIfAborted();
      }
      if ((row.flags & EntityFlags.HAS_GEOMETRY) === 0 || (row.flags & EntityFlags.IS_TYPE) !== 0) continue;
      elements += 1;
      classes.set(row.type, (classes.get(row.type) ?? 0) + 1);
      if (scanned >= SCHEMA_SCAN_LIMIT) continue;
      scanned += 1;
      const seen = reader.observe([row.expressId]);
      for (const { psetName, propertyName } of seen.properties.values()) bump('property', psetName, propertyName, modelId);
      for (const { qsetName, quantityName } of seen.quantities.values()) bump('quantity', qsetName, quantityName, modelId);
      for (const name of seen.relations.classificationSystems) bump('classification', '', name, modelId);
      mergeObservations(observations, seen);
    }
    partial ||= scanned < elements;
    models.push({ modelId, name: model.name, elements, scanned });
  }
  signal?.throwIfAborted();
  return { models, classes, fields, catalog: catalogFromObservations(observations), partial };
}
