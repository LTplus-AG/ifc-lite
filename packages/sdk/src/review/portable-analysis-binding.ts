/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Existing bijective saved source binding shared by native Review and viewer (#7372). */
import type { SavedAnalysisRun, SavedRunModel } from './portable-analysis.js';

export interface PortableAnalysisBindingState {
  models: ReadonlyMap<string, { name: string; sourceFingerprint?: string; sourceContentHash?: string }>;
  realignedFrameKey?: string | null;
  hasChanges: (modelId: string) => boolean;
  /** Canonical actual placement evidence, not guessed offsets or model names. */
  placementMatches: (modelId: string, recorded: NonNullable<SavedRunModel['placement']>) => boolean;
}

export type BindRefusalCode = 'runEdited' | 'frameChanged' | 'modelSetChanged' | 'modelEdited' | 'sourceUnknown' | 'modelMissing' | 'modelReplaced' | 'modelAmbiguous' | 'modelMoved';
export interface BindRefusal { code: BindRefusalCode; model?: string; before?: number; open?: number }

function sameSource(saved: SavedRunModel, open: { sourceFingerprint?: string; sourceContentHash?: string }): boolean {
  // The full-content hash decides whenever both sides have it; the sampled fingerprint only when one side lacks it.
  if (saved.sourceContentHash && open.sourceContentHash) return saved.sourceContentHash === open.sourceContentHash;
  return !!saved.sourceFingerprint && saved.sourceFingerprint === open.sourceFingerprint;
}

/** Resolve each saved model to one open model, or every reason it cannot be. */
export function bindSavedAnalysisModels(saved: Pick<SavedAnalysisRun, 'models' | 'edited' | 'placementRecorded' | 'frame'>, state: PortableAnalysisBindingState):
  { ok: true; ids: Map<string, string> } | { ok: false; refusals: BindRefusal[] } {
  const refusals: BindRefusal[] = [];
  if (saved.edited) refusals.push({ code: 'runEdited' });
  // In its session a placement-stamped run goes stale when the realignment or the open-model set changes
  // (`isAnalysisStale`); a reopened run gets a fresh stamp, so either difference refuses here instead.
  if (saved.frame) {
    if ((state.realignedFrameKey ?? null) !== saved.frame.realignedFrameKey) refusals.push({ code: 'frameChanged' });
    if (state.models.size !== saved.frame.openModels) refusals.push({ code: 'modelSetChanged', before: saved.frame.openModels, open: state.models.size });
  }
  const ids = new Map<string, string>();
  const claimed = new Map<string, string>();
  // The frame's other models are bound like the examined ones (same file, open once, unedited, unmoved), never used by the run.
  for (const model of [...saved.models, ...saved.frame?.others ?? []]) {
    if (!model.sourceContentHash && !model.sourceFingerprint) { refusals.push({ code: 'sourceUnknown', model: model.name }); continue; }
    const matches = [...state.models].filter(([, open]) => sameSource(model, open)).map(([id]) => id);
    if (matches.length === 0) {
      refusals.push({ code: [...state.models.values()].some(open => open.name === model.name) ? 'modelReplaced' : 'modelMissing', model: model.name });
      continue;
    }
    // Two open copies of one file, or two saved models claiming one open model: neither has an identity.
    if (matches.length > 1 || claimed.has(matches[0])) { refusals.push({ code: 'modelAmbiguous', model: model.name }); continue; }
    const id = matches[0];
    claimed.set(id, model.key);
    // Unsaved edits mean the open model no longer is the file its source identity names.
    if (state.hasChanges(id)) { refusals.push({ code: 'modelEdited', model: model.name }); continue; }
    if (saved.placementRecorded) {
      // The caller supplies the canonical placement comparison; a missing
      // recorded placement remains unknown rather than an inferred match.
      if (!model.placement || !state.placementMatches(id, model.placement)) {
        refusals.push({ code: 'modelMoved', model: model.name });
        continue;
      }
    }
    ids.set(model.key, id);
  }
  return refusals.length ? { ok: false, refusals } : { ok: true, ids };
}
