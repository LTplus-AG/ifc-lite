/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One review snapshot: every registered source's runs and findings, grouped into cards. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { effectiveStoreyId } from '../effective-storey';
import { buildCards, type CoordinationCard, type ReviewTotals } from './cards';
import { FINDING_SOURCES } from './sources';
import type { FindingRun, FindingSource, ReviewFinding, ReviewModel } from './types';

export interface ReviewSnapshot {
  runs: FindingRun[];
  findings: ReviewFinding[];
  cards: CoordinationCard[];
  totals: ReviewTotals;
  /** Sources that threw; their findings are absent, never silently empty. */
  failed: Array<{ source: FindingSource['kind']; message: string }>;
}

export function reviewModel(id: string, name: string, store: IfcDataStore, view?: MutablePropertyView | null): ReviewModel {
  return {
    id, name,
    expressIdOf: globalId => store.entities.getExpressIdByGlobalId(globalId),
    globalIdOf: expressId => store.entities.getGlobalId(expressId) ?? '',
    storeyOf: expressId => {
      const storey = effectiveStoreyId(store, view, expressId);
      return storey ? store.entities.getName(storey) || null : null;
    },
  };
}

export function liveReviewModels(): ReviewModel[] {
  const state = useViewerStore.getState();
  return [...state.models.values()].flatMap(model => model.ifcDataStore
    ? [reviewModel(model.id, model.name, model.ifcDataStore, state.mutationViews.get(model.id))] : []);
}

export function snapshotFrom(sources: readonly FindingSource[], models: readonly ReviewModel[]): ReviewSnapshot {
  const runs: FindingRun[] = [];
  const findings: ReviewFinding[] = [];
  const failed: ReviewSnapshot['failed'] = [];
  for (const source of sources) {
    try {
      const result = source.collect(models);
      runs.push(...result.runs);
      findings.push(...result.findings);
    } catch (error) {
      console.warn(`[Review] ${source.kind} findings unavailable`, error);
      failed.push({ source: source.kind, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const { cards, totals } = buildCards(findings, models);
  return { runs, findings, cards, totals, failed };
}

export function captureReviewSnapshot(): ReviewSnapshot {
  return snapshotFrom(FINDING_SOURCES, liveReviewModels());
}
