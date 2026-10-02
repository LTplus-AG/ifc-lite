/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChecklistTemplate, ManualAnswerMap } from './checklist.js';
import type { ManualAnswersByModel } from './persistence.js';

/** Live editable checklists differ from the immutable saved-report history
 * (#6500). Imported templates may share item ids; answers belong to this
 * instance first, then to the actual source model fingerprint (#6507). */
export interface ManualChecklistInstance {
  id: string;
  template: ChecklistTemplate;
  answers: ManualAnswersByModel;
  /** Saved-report copies reopen on their recorded source, even when a peer is active. */
  preferredModelFingerprint?: string;
}

export interface ManualChecklistLibrary {
  version: 1;
  activeId: string | null;
  checklists: ManualChecklistInstance[];
  /** One-time migration of old answers left behind when its template was
   * closed. Imported templates claim matching item ids; unmatched evidence
   * remains until a matching template is opened. The old record carries
   * no discipline/template identity. Never populated by editing. */
  pendingLegacyAnswers?: ManualAnswersByModel;
}

export function emptyManualLibrary(): ManualChecklistLibrary {
  return { version: 1, activeId: null, checklists: [] };
}

/** Existing editors/converters use these active projections, so checklist
 * switching cannot introduce a second answer or summary implementation. */
export function manualLibraryProjection(library: ManualChecklistLibrary) {
  const active = library.checklists.find((entry) => entry.id === library.activeId);
  return { manualChecklist: active?.template ?? null, manualAnswers: active?.answers ?? library.pendingLegacyAnswers ?? {} };
}

/** A closed legacy template is unknown. Claim only questions actually in
 * the imported file; preserve unmatched answers for another template.
 * Matching item ids cannot recover the missing discipline identity. */
export function claimLegacyManualAnswers(template: ChecklistTemplate, pending: ManualAnswersByModel) {
  const itemIds = new Set(template.groups.flatMap((group) => group.items.map((item) => item.id)));
  const partition = (matching: boolean): ManualAnswersByModel => Object.fromEntries(
    Object.entries(pending).map(([fingerprint, answers]): [string, ManualAnswerMap] => [fingerprint, Object.fromEntries(
      Object.entries(answers).filter(([id]) => itemIds.has(id) === matching),
    )]).filter(([, answers]) => Object.keys(answers).length > 0),
  );
  return { answers: partition(true), remaining: partition(false) };
}
