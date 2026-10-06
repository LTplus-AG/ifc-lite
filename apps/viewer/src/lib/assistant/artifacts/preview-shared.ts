/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared shapes of the review's evidence (see `artifact-preview.ts`).
 *
 * The review's evidence: a proposal run through its own native engine against
 * the loaded models, before anything is saved. Every number here comes from
 * that engine (`evaluateFilterGroupsFederated`, `runListFederated`, the Lens
 * engine, Charts `aggregate`); this module only counts what came back, per
 * model, and states the denominators: how many rows carry a measured value and
 * how many do not, in which unit.
 */

import type { ViewerState } from '@/store';
import type { FilterGroup } from '@ifc-lite/rules';
import type { ListDefinition } from '@ifc-lite/lists';
import type { Lens } from '@ifc-lite/lens';
import type { ChartScope, ChartSpec } from '@ifc-lite/charts';
import { chartScopeKey } from '@/lib/charts/datasets/elements';

export type ArtifactPreviewKind = 'filter.proposal' | 'list.proposal' | 'lens.proposal' | 'chart.proposal';

export interface ModelPopulation { modelId: string; name: string; count: number }
export interface SampleRow { model: string; ifcClass: string; name: string; globalId: string; values: string[] }
/** A summed value and its denominator: `measured` of `rows` carried it (a chart's `rows` are its charted rows). */
export interface MeasureSummary { label: string; unit: string | null; total: number; measured: number; rows: number }
export interface PreviewBucket { label: string; count: number; value?: number; color?: string; absence?: boolean }

export interface ArtifactPreview {
  kind: ArtifactPreviewKind;
  /** Distinct elements (or rows) the engine returned. */
  matched: number;
  population: ModelPopulation[];
  sampleColumns: string[];
  samples: SampleRow[];
  measures: MeasureSummary[];
  buckets: PreviewBucket[];
  /** Lens: loaded elements no rule or value colours. Chart: rows without a dimension value. */
  unassigned?: number;
  /** Chart: the unit the aggregation is in, when it sums a measure. */
  unit?: string;
  /** The library artifact this preview describes, ready to save. */
  artifact: PreviewArtifact;
  /** Federation identity and mutation revision the numbers belong to. */
  revision: PreviewRevision;
}

export type PreviewArtifact =
  | { kind: 'filter.proposal'; name: string; groups: FilterGroup[] }
  | { kind: 'list.proposal'; definition: ListDefinition }
  | { kind: 'lens.proposal'; lens: Lens }
  | { kind: 'chart.proposal'; spec: ChartSpec; scope: ChartScope };

/** `scope`: a chart's `chartScopeKey`, what a visible or basket chart counts beyond the models; `null` otherwise. */
export interface PreviewRevision { models: object; mutationVersion: number; scope: string | object | null }

export const SAMPLE_LIMIT = 8;

type RevisionState = Pick<ViewerState, 'models' | 'mutationVersion' | 'pinboardEntities'>;

/** The scope key `artifact`'s numbers depend on: only a chart has a scope. */
export function artifactScopeKey(artifact: PreviewArtifact, state: Pick<ViewerState, 'pinboardEntities'>): string | object | null {
  return artifact.kind === 'chart.proposal' ? chartScopeKey(artifact.scope, state) : null;
}

export function revisionOf(state: Pick<ViewerState, 'models' | 'mutationVersion'>, scope: string | object | null = null): PreviewRevision {
  return { models: state.models, mutationVersion: state.mutationVersion, scope };
}

export function isPreviewCurrent(preview: ArtifactPreview, state: RevisionState): boolean {
  return preview.revision.models === state.models && preview.revision.mutationVersion === state.mutationVersion
    && preview.revision.scope === artifactScopeKey(preview.artifact, state);
}

/** Count rows per loaded model, in federation order; models with no rows are listed with 0. */
export function populationOf(rows: Iterable<{ modelId: string }>, state: Pick<ViewerState, 'models'>): ModelPopulation[] {
  const counts = new Map<string, number>();
  for (const { modelId } of rows) counts.set(modelId, (counts.get(modelId) ?? 0) + 1);
  const out: ModelPopulation[] = [...state.models].map(([modelId, model]) => ({ modelId, name: model.name, count: counts.get(modelId) ?? 0 }));
  for (const [modelId, count] of counts) if (!state.models.has(modelId)) out.push({ modelId, name: modelId, count });
  return out;
}

