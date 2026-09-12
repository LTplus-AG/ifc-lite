/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `elements` dataset straight off a model's entity table: one row per
 * element instance with its IFC type, storey and model — the three
 * dimensions every overview chart wants, read from the columnar tables in
 * one pass, no per-entity extraction. Property / quantity / material columns
 * are the lists engine's job (a host merges those in through
 * `ListDefinition` columns); this is the fast path that needs no list.
 *
 * Rows carry RENDERER ids: `expressId + idOffset` for the model's slot in a
 * federation, so a bucket's ids can go straight to selection / visibility.
 */
import { EntityFlags } from '@ifc-lite/data';
import type { ChartDataset, ChartDatasetColumn, ChartDatasetRow } from './types.js';

/** The columns of a columnar entity table this adapter reads — structural, so
 *  any store shape that carries them (parsed, cached, server-hydrated) works. */
export interface ElementsEntityTable {
  readonly count: number;
  readonly expressId: ArrayLike<number>;
  /** `EntityFlags` bits per row. */
  readonly flags: ArrayLike<number>;
  getName(expressId: number): string;
  getTypeName(expressId: number): string;
}

export interface ElementsStore {
  entities: ElementsEntityTable;
  spatialHierarchy?: { elementToStorey: ReadonlyMap<number, number> };
}

export const ELEMENT_COLUMNS = {
  ifcType: 'IfcType',
  storey: 'Storey',
  model: 'Model',
  name: 'Name',
} as const;

export const ELEMENT_DATASET_COLUMNS: ChartDatasetColumn[] = [
  { id: ELEMENT_COLUMNS.ifcType, label: 'IFC type', kind: 'category' },
  { id: ELEMENT_COLUMNS.storey, label: 'Storey', kind: 'category' },
  { id: ELEMENT_COLUMNS.model, label: 'Model', kind: 'category' },
  { id: ELEMENT_COLUMNS.name, label: 'Name', kind: 'category' },
];

export interface ElementsDatasetModel {
  /** The parsed store (its `entities` + `spatialHierarchy` are read). */
  store: ElementsStore;
  /** Renderer id offset of this model's slot; 0 for a single model. */
  idOffset: number;
  /** Human model name for the `Model` column. */
  name: string;
  /** Keep only these express ids (a list scope, the visible set); all when absent. */
  include?: ReadonlySet<number>;
}

/** Only instances with geometry are chartable elements — types, styles, relationships are not. */
function isElementRow(flags: number): boolean {
  return (flags & EntityFlags.HAS_GEOMETRY) !== 0 && (flags & EntityFlags.IS_TYPE) === 0;
}

export function elementsDataset(models: readonly ElementsDatasetModel[]): ChartDataset {
  const rows: ChartDatasetRow[] = [];
  const fingerprintParts: string[] = [];
  for (const model of models) {
    const { entities, spatialHierarchy } = model.store;
    const storeyNames = new Map<number, string>();
    const storeyOf = (expressId: number): string => {
      const storeyId = spatialHierarchy?.elementToStorey.get(expressId);
      if (!storeyId) return '';
      let cached = storeyNames.get(storeyId);
      if (cached === undefined) {
        cached = entities.getName(storeyId) || '';
        storeyNames.set(storeyId, cached);
      }
      return cached;
    };
    let kept = 0;
    for (let i = 0; i < entities.count; i++) {
      if (!isElementRow(entities.flags[i])) continue;
      const expressId = entities.expressId[i];
      if (model.include && !model.include.has(expressId)) continue;
      kept += 1;
      rows.push({
        ids: [expressId + model.idOffset],
        values: [entities.getTypeName(expressId), storeyOf(expressId), model.name, entities.getName(expressId)],
      });
    }
    fingerprintParts.push(`${model.name}@${model.idOffset}:${kept}/${entities.count}`);
  }
  return { source: 'elements', columns: ELEMENT_DATASET_COLUMNS, rows, fingerprint: fingerprintParts.join('|') };
}
