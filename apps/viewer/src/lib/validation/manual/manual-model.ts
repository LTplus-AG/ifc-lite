/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which model's answers the Manual validation tab shows and a manual report
 * block snapshots (#6401). One rule for both, so a report added right after
 * answering reads the answers that were on screen: an explicit pick, else
 * the active model, else the first loaded one.
 */

import type { FederatedModel } from '@/store';
import type { ManualAnswerMap } from './checklist.js';
import type { ManualAnswersByModel } from './persistence.js';
import { isManualModelReady } from './report-reuse.js';
export { manualReportReuse } from './report-reuse.js';

export interface ManualModelOption {
  id: string;
  name: string;
  /** Answers are keyed by this; null (also for an empty fingerprint) means the model cannot hold answers. */
  fingerprint: string | null;
  loadState?: FederatedModel['loadState'];
}

const NO_ANSWERS: ManualAnswerMap = Object.freeze({});

export function manualModelOptions(models: ReadonlyMap<string, Pick<FederatedModel, 'id' | 'name' | 'sourceFingerprint' | 'loadState'>>): ManualModelOption[] {
  return [...models.values()].map((m) => ({ id: m.id, name: m.name, fingerprint: m.sourceFingerprint || null, loadState: m.loadState }));
}

export function pickManualModel(options: readonly ManualModelOption[], picked: string | null, activeModelId: string | null, preferredFingerprint?: string): ManualModelOption | null {
  const explicit = options.find((m) => m.id === picked);
  if (explicit) return explicit;
  if (preferredFingerprint) return options.find((m) => m.fingerprint === preferredFingerprint && isManualModelReady(m)) ?? null;
  return options.find((m) => m.id === activeModelId) ?? options[0] ?? null;
}

export function answersForModel(all: ManualAnswersByModel, model: ManualModelOption | null): ManualAnswerMap {
  return (model?.fingerprint && all[model.fingerprint]) || NO_ANSWERS;
}

/**
 * The model a report block's Refresh reads (#6401). An explicit pick wins.
 * Otherwise a block bound to a fingerprint reads that model only: when it is
 * not loaded the result is `missing`, never a stand-in, so answers from
 * another model cannot be snapshotted under this block. An unbound block
 * (none was loaded when it was taken) follows `defaultModelId`.
 */
export type ReportModelResolution =
  | { kind: 'model'; model: ManualModelOption | null }
  | { kind: 'missing' };

export function resolveReportModel(
  options: readonly ManualModelOption[],
  boundFingerprint: string | undefined,
  picked: string | null,
  defaultModelId: string | null,
): ReportModelResolution {
  const pickedModel = picked === null ? undefined : options.find((m) => m.id === picked);
  if (pickedModel) return { kind: 'model', model: pickedModel };
  if (boundFingerprint) {
    const bound = options.find((m) => m.fingerprint === boundFingerprint && isManualModelReady(m));
    return bound ? { kind: 'model', model: bound } : { kind: 'missing' };
  }
  return { kind: 'model', model: options.find((m) => m.id === defaultModelId) ?? null };
}
