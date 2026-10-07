/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Capture the current clash result as a saved report (#6947), and compare a
 * saved report's models with the loaded ones.
 *
 * Capture reads each row's review, group and storey through `liveClashFacts`,
 * the same function the live `clash` chart dataset uses, so a report holds
 * exactly the values a chart of the current result showed when it was saved.
 */

import type { ClashResult } from '@ifc-lite/clash';
import { analysisStampOf, isAnalysisStale } from '@/hooks/useAnalysisStaleness';
import type { ViewerState } from '@/store';
import { clashGroupTitles, liveClashFacts, type ClashDatasetState } from '@/lib/charts/datasets/clash';
import { clashReviewKey } from '@ifc-lite/clash';
import type { SavedClash, SavedClashElement, SavedClashModel, SavedClashReport, SavedClashRule } from './saved-report-schema';

export * from './saved-report-schema';

export type ClashReportCaptureState = ClashDatasetState
  & Pick<ViewerState, 'clashRawResult' | 'clashGroupsKind' | 'clashSuppressedCount' | 'mutationVersion' | 'geometryContentVersion' | 'modelPlacement'>;

export const newClashReportId = (): string => `clash-report-${crypto.randomUUID()}`;

function savedRules(result: ClashResult): SavedClashRule[] {
  const coverage = new Map((result.ruleCoverage ?? []).map((entry) => [entry.rule, entry]));
  return result.rulesRun.map((rule) => {
    const matched = coverage.get(rule.id);
    return {
      id: rule.id, name: rule.name, a: rule.a, mode: rule.mode,
      ...(rule.b !== undefined ? { b: rule.b } : {}),
      ...(rule.tolerance !== undefined ? { tolerance: rule.tolerance } : {}),
      ...(rule.clearance !== undefined ? { clearance: rule.clearance } : {}),
      ...(rule.severity !== undefined ? { severity: rule.severity } : {}),
      ...(rule.reportTouch !== undefined ? { reportTouch: rule.reportTouch } : {}),
      // The engine drops member lists from `rulesRun` and flags them in the coverage; either one marks the side.
      ...(matched?.fromMembersA || rule.membersA !== undefined ? { fromMembersA: true } : {}),
      ...(matched?.fromMembersB || rule.membersB !== undefined ? { fromMembersB: true } : {}),
      ...(matched ? { matchedA: matched.matchedA, matchedB: matched.matchedB } : {}),
    };
  });
}

/**
 * The current result (exclusions applied, as the panel and the charts read
 * it) as a named report, or null when there is no result. A result whose
 * models changed since the run is still saved, flagged `stale`: refusing would
 * lose the evidence, and the flag keeps it from reading as a complete run.
 */
export function snapshotClashReport(state: ClashReportCaptureState, name: string, now: Date = new Date()): SavedClashReport | null {
  const result = state.clashResult;
  if (!result) return null;
  const stamp = analysisStampOf(state.clashRawResult ?? result);
  const groupOf = clashGroupTitles(state);
  // The run's federation when the run recorded it, otherwise the models its clashes name.
  const modelIds = new Set<string>(stamp?.placement ? stamp.placement.keys() : []);
  const element = (ref: { key: string; model: string; tag: string; name?: string }): SavedClashElement => {
    modelIds.add(ref.model);
    return { key: ref.key, model: ref.model, tag: ref.tag, ...(ref.name !== undefined ? { name: ref.name } : {}) };
  };
  const clashes: SavedClash[] = result.clashes.map((clash) => {
    const facts = liveClashFacts(state, clash, groupOf);
    const comment = state.clashReviews.get(clashReviewKey(clash))?.comment;
    return {
      id: clash.id, rule: clash.rule, status: clash.status, severity: clash.severity,
      distance: Number.isFinite(clash.distance) ? clash.distance : null,
      ...(clash.distanceKind ? { distanceKind: clash.distanceKind } : {}),
      a: element(clash.a), b: element(clash.b),
      storey: facts.storey, review: facts.review,
      ...(comment ? { comment } : {}),
      group: facts.group,
    };
  });
  const models: SavedClashModel[] = [...modelIds].map((id) => {
    const model = state.models.get(id);
    return {
      id, name: model?.name?.trim() ? model.name : id,
      ...(model?.sourceFingerprint ? { sourceFingerprint: model.sourceFingerprint } : {}),
      ...(model?.sourceContentHash ? { sourceContentHash: model.sourceContentHash } : {}),
    };
  });
  const id = newClashReportId();
  return {
    version: 1, id, name: name.trim() || defaultClashReportName(result, now), savedAt: now.toISOString(),
    run: {
      settings: { tolerance: result.settings.tolerance, excludeVoidsAndHosts: result.settings.excludeVoidsAndHosts },
      rules: savedRules(result),
      ...(stamp ? { mutationRevision: stamp.mutationVersion } : {}),
    },
    models,
    completeness: {
      ...(result.truncated ? { truncated: { reason: result.truncated.reason, droppedPairs: result.truncated.droppedPairs } } : {}),
      stale: isAnalysisStale(stamp, { mutationVersion: state.mutationVersion, geometryContentVersion: state.geometryContentVersion,
        modelPlacement: state.modelPlacement, models: state.models }),
      excluded: state.clashSuppressedCount,
    },
    grouping: state.clashGroupsKind,
    clashes,
  };
}

/** The name a report gets when the user leaves the field empty: its rules and the time it was saved. */
export function defaultClashReportName(result: Pick<ClashResult, 'rulesRun'>, now: Date): string {
  const names = result.rulesRun.map((rule) => rule.name).filter(Boolean);
  const rules = names.length === 0 ? 'Clash run' : names.length <= 2 ? names.join(', ') : `${names[0]} +${names.length - 1}`;
  return `${rules} ${now.toISOString().slice(0, 16).replace('T', ' ')}`.slice(0, 200);
}
