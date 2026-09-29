/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manual validation state (#6507): independently editable checklist
 * instances, with active projections for the canonical existing editor.
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
  serializeChecklist,
  type ChecklistTemplate,
  type ManualAnswer,
  type ManualVerdict,
} from '@/lib/validation/manual/checklist';
import * as edit from '@/lib/validation/manual/checklist-edit';
import {
  isMeaningfulAnswer,
  loadManualLibrary,
  saveManualLibrary,
  type ManualAnswersByModel,
  type ManualSaveResult,
} from '@/lib/validation/manual/persistence';
import { claimLegacyManualAnswers, manualLibraryProjection, type ManualChecklistLibrary } from '@/lib/validation/manual/library';

export interface ManualValidationSlice {
  /** Independent live instances; saved report snapshots remain separate. */
  manualLibrary: ManualChecklistLibrary;
  selectManualChecklist: (id: string) => void;
  removeManualChecklist: (id: string) => void;
  duplicateManualChecklist: (id: string, name?: string) => void;
  /** The checklist being filled in or edited; null before one is created or opened. */
  manualChecklist: ChecklistTemplate | null;
  /** fingerprint → itemId → answer. */
  manualAnswers: ManualAnswersByModel;
  /** The last persistence failure, until the next successful write. */
  manualSaveError: ManualSaveResult | null;

  /** Open/select a template; null deactivates it while retaining its instance. */
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
  const initial = loadManualLibrary();
  const commitLibrary = (manualLibrary: ManualChecklistLibrary) => {
    const result = saveManualLibrary(manualLibrary);
    set({ manualLibrary, ...manualLibraryProjection(manualLibrary), manualSaveError: result.ok ? null : result });
    return result;
  };
  const commitChecklist = (template: ChecklistTemplate) => {
    const library = get().manualLibrary;
    if (!library.activeId) return;
    commitLibrary({ ...library, checklists: library.checklists.map((entry) => entry.id === library.activeId ? { ...entry, template } : entry) });
  };
  const withChecklist = (fn: (template: ChecklistTemplate) => ChecklistTemplate) => {
    const current = get().manualChecklist;
    if (current) commitChecklist(fn(current));
  };
  const addChecklist = (template: ChecklistTemplate, imported: boolean) => {
    const library = get().manualLibrary;
    const id = `manual-checklist-${crypto.randomUUID()}`;
    const claim = imported ? claimLegacyManualAnswers(template, library.pendingLegacyAnswers ?? {}) : { answers: {}, remaining: library.pendingLegacyAnswers ?? {} };
    const next = { ...library, activeId: id, checklists: [...library.checklists, { id, template, answers: claim.answers }] };
    if (Object.keys(claim.remaining).length) next.pendingLegacyAnswers = claim.remaining;
    else delete next.pendingLegacyAnswers;
    commitLibrary(next);
  };

  return {
    manualLibrary: initial.library,
    ...manualLibraryProjection(initial.library),
    manualSaveError: initial.error,

    selectManualChecklist: (id) => {
      const library = get().manualLibrary;
      if (library.checklists.some((entry) => entry.id === id)) commitLibrary({ ...library, activeId: id });
    },
    removeManualChecklist: (id) => {
      const library = get().manualLibrary;
      const checklists = library.checklists.filter((entry) => entry.id !== id);
      commitLibrary({ ...library, checklists, activeId: library.activeId === id ? checklists[0]?.id ?? null : library.activeId });
    },
    duplicateManualChecklist: (id, name) => {
      const entry = get().manualLibrary.checklists.find((candidate) => candidate.id === id);
      if (entry) addChecklist({ ...structuredClone(entry.template), name: name ?? entry.template.name }, false);
    },
    setManualChecklist: (template) => {
      const library = get().manualLibrary;
      if (template === null) { commitLibrary({ ...library, activeId: null }); return; }
      // Reopening the same saved template selects its existing instance and
      // answers; differently named disciplines with identical item ids stay
      // independent. Template editing updates only the selected instance.
      const encoded = serializeChecklist(template);
      const existing = library.checklists.find((entry) => serializeChecklist(entry.template) === encoded);
      if (existing) commitLibrary({ ...library, activeId: existing.id });
      else addChecklist(template, true);
    },
    newManualChecklist: () => addChecklist(blankChecklist(), false),
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
      const library = get().manualLibrary;
      if (!library.activeId) return { ok: true };
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
      // Reflect the edit even if storage refuses it, while keeping the same
      // visible persistence alert as the original manual-validation flow.
      return commitLibrary({ ...library, checklists: library.checklists.map((entry) => entry.id === library.activeId ? { ...entry, answers: next } : entry) });
    },
  };
};
