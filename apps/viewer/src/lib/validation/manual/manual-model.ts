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

export interface ManualModelOption {
  id: string;
  name: string;
  /** Answers are keyed by this; null (also for an empty fingerprint) means the model cannot hold answers. */
  fingerprint: string | null;
}

const NO_ANSWERS: ManualAnswerMap = Object.freeze({});

export function manualModelOptions(models: ReadonlyMap<string, Pick<FederatedModel, 'id' | 'name' | 'sourceFingerprint'>>): ManualModelOption[] {
  return [...models.values()].map((m) => ({ id: m.id, name: m.name, fingerprint: m.sourceFingerprint || null }));
}

export function pickManualModel(options: readonly ManualModelOption[], picked: string | null, activeModelId: string | null): ManualModelOption | null {
  return options.find((m) => m.id === picked) ?? options.find((m) => m.id === activeModelId) ?? options[0] ?? null;
}

export function answersForModel(all: ManualAnswersByModel, model: ManualModelOption | null): ManualAnswerMap {
  return (model?.fingerprint && all[model.fingerprint]) || NO_ANSWERS;
}
