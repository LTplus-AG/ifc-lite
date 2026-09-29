/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manual validation state (#6401): the working checklist template and the
 * answers recorded against it, per model.
 *
 * Deliberately NOT part of `idsSlice`'s `idsValidationReport`: a manual
 * verdict is a different kind of evidence, and an IDS or information run
 * must never replace it (nor it them).
 *
 * Answers are keyed by the model's `sourceFingerprint` — a durable identity
 * that survives a reload and names no runtime model id — so nothing here
 * goes stale when a model is removed; see the `teardown-exemptions.ts` entry.
 */

import type { StateCreator } from 'zustand';
import {
  MAX_ANSWER_COMMENT,
  blankChecklist,
  type ChecklistTemplate,
  type ManualAnswer,
  type ManualVerdict,
} from '@/lib/validation/manual/checklist';
import * as edit from '@/lib/validation/manual/checklist-edit';
import {
  isMeaningfulAnswer,
  loadManualAnswers,
  loadWorkingChecklist,
  saveManualAnswers,
  saveWorkingChecklist,
  type ManualAnswersByModel,
  type ManualSaveResult,
} from '@/lib/validation/manual/persistence';

export interface ManualValidationSlice {
  /** The checklist being filled in or edited; null before one is created or opened. */
  manualChecklist: ChecklistTemplate | null;
  /** fingerprint → itemId → answer. */
  manualAnswers: ManualAnswersByModel;
  /** The last persistence failure, until the next successful write. */
  manualSaveError: ManualSaveResult | null;

  /** Replace the working checklist (new / opened / recent); null closes it. Answers are kept. */
  setManualChecklist: (template: ChecklistTemplate | null) => void;
  newManualChecklist: () => void;
  renameManualChecklist: (name: string) => void;
  addManualGroup: (name: string) => string | null;
  renameManualGroup: (groupId: string, name: string) => void;
  removeManualGroup: (groupId: string) => void;
  moveManualGroup: (groupId: string, delta: number) => void;
  addManualItem: (groupId: string, text: string) => string | null;
  updateManualItem: (groupId: string, itemId: string, patch: { text?: string; description?: string }) => void;
  removeManualItem: (groupId: string, itemId: string) => void;
  moveManualItem: (groupId: string, itemId: string, delta: number) => void;
  /** Merge a verdict and/or comment into one item's answer on one model, and persist. */
  setManualAnswer: (
    fingerprint: string,
    itemId: string,
    patch: { status?: ManualVerdict | null; comment?: string },
  ) => ManualSaveResult;
}

export const createManualValidationSlice: StateCreator<ManualValidationSlice, [], [], ManualValidationSlice> = (set, get) => {
  const commitChecklist = (next: ChecklistTemplate | null) => {
    if (next === get().manualChecklist) return;
    const result = saveWorkingChecklist(next);
    set({ manualChecklist: next, manualSaveError: result.ok ? null : result });
  };
  const withChecklist = (fn: (t: ChecklistTemplate) => ChecklistTemplate) => {
    const current = get().manualChecklist;
    if (current) commitChecklist(fn(current));
  };

  return {
    manualChecklist: loadWorkingChecklist(),
    manualAnswers: loadManualAnswers(),
    manualSaveError: null,

    setManualChecklist: (template) => commitChecklist(template),
    newManualChecklist: () => commitChecklist(blankChecklist()),
    renameManualChecklist: (name) => withChecklist((t) => edit.renameChecklist(t, name)),
    addManualGroup: (name) => {
      const current = get().manualChecklist;
      if (!current) return null;
      const { template, id } = edit.addGroup(current, name);
      commitChecklist(template);
      return id;
    },
    renameManualGroup: (groupId, name) => withChecklist((t) => edit.renameGroup(t, groupId, name)),
    removeManualGroup: (groupId) => withChecklist((t) => edit.removeGroup(t, groupId)),
    moveManualGroup: (groupId, delta) => withChecklist((t) => edit.moveGroup(t, groupId, delta)),
    addManualItem: (groupId, text) => {
      const current = get().manualChecklist;
      if (!current) return null;
      const { template, id } = edit.addItem(current, groupId, text);
      commitChecklist(template);
      return id;
    },
    updateManualItem: (groupId, itemId, patch) => withChecklist((t) => edit.updateItem(t, groupId, itemId, patch)),
    removeManualItem: (groupId, itemId) => withChecklist((t) => edit.removeItem(t, groupId, itemId)),
    moveManualItem: (groupId, itemId, delta) => withChecklist((t) => edit.moveItem(t, groupId, itemId, delta)),

    setManualAnswer: (fingerprint, itemId, patch) => {
      const all = get().manualAnswers;
      const forModel = { ...all[fingerprint] };
      const prev = forModel[itemId];
      const status = patch.status !== undefined ? patch.status : (prev?.status ?? null);
      const comment = (patch.comment ?? prev?.comment ?? '').slice(0, MAX_ANSWER_COMMENT);
      const answer: ManualAnswer = { status, updatedAt: Date.now() };
      if (comment.trim().length > 0) answer.comment = comment;
      if (isMeaningfulAnswer(answer)) forModel[itemId] = answer;
      else delete forModel[itemId];
      const next = { ...all, [fingerprint]: forModel };
      const result = saveManualAnswers(next);
      // Reflect the edit even when storage refused it, so the UI stays
      // responsive; `manualSaveError` lets the panel say it was not kept.
      set({ manualAnswers: next, manualSaveError: result.ok ? null : result });
      return result;
    },
  };
};
