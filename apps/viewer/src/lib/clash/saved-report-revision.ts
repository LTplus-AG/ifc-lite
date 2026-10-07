/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SavedClashModel, SavedClashReport } from './saved-report-schema';

/**
 * How the loaded models relate to the ones a report was recorded on.
 * `same`: every recorded model is loaded with an identical source identity and
 *   neither side carries in-session edits.
 * `different`: a recorded model's name is loaded with another source identity.
 * `not-loaded`: a recorded model is not loaded at all.
 * `unverified`: nothing above could be established (no source identity was
 *   recorded, or one side was edited in the viewer).
 * This only labels the report. A report is never resolved against the loaded
 * models, whichever answer this gives.
 */
export type ClashReportRevision = 'same' | 'different' | 'not-loaded' | 'unverified';

export interface LoadedModelIdentity { name: string; sourceFingerprint?: string; sourceContentHash?: string }

function sameSource(saved: SavedClashModel, loaded: LoadedModelIdentity): boolean {
  // The full-content hash decides whenever both sides have it; the sampled fingerprint only when one side lacks it.
  if (saved.sourceContentHash && loaded.sourceContentHash) return saved.sourceContentHash === loaded.sourceContentHash;
  return !!saved.sourceFingerprint && saved.sourceFingerprint === loaded.sourceFingerprint;
}

export function clashReportRevision(report: Pick<SavedClashReport, 'models' | 'run'>, loaded: readonly LoadedModelIdentity[], mutationVersion: number): ClashReportRevision {
  if (report.models.length === 0) return 'unverified';
  let unverified = report.run.mutationRevision !== 0 || mutationVersion !== 0;
  let notLoaded = false;
  for (const model of report.models) {
    if (loaded.some((candidate) => sameSource(model, candidate))) continue;
    if (!model.sourceFingerprint && !model.sourceContentHash) {
      if (loaded.some((candidate) => candidate.name === model.name)) unverified = true;
      else notLoaded = true;
    } else if (loaded.some((candidate) => candidate.name === model.name)) return 'different';
    else notLoaded = true;
  }
  return notLoaded ? 'not-loaded' : unverified ? 'unverified' : 'same';
}
