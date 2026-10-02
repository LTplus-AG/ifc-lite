/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RuleSetFile } from '@ifc-lite/rules';
import type { StateCreator } from 'zustand';
import { defineSliceTeardown, notApplicable } from '../teardown.js';
import type { IDSSlice } from './idsSlice.js';
import {
  activeDefinition, checkDefinitionLibrary, loadDefinitionLibrary, saveDefinitionLibrary,
  type DefinitionKind, type DefinitionLibrary, type ValidationDefinition,
} from '@/lib/validation/definition-library';

/** The unsaved Information validation editor survives sidebar unmounts. */
export interface ValidationDraftSlice {
  validationDefinitions: DefinitionLibrary;
  validationDefinitionsError: string | null;
  validationDefinitionsWritable: boolean;
  validationDefinitionRevision: number;
  addValidationDefinition: (definition: Omit<Extract<ValidationDefinition, { kind: 'rules' }>, 'id'> | Omit<Extract<ValidationDefinition, { kind: 'ids' }>, 'id'>, existingId?: string) => boolean;
  selectValidationDefinition: (id: string) => void;
  removeValidationDefinition: (id: string) => void;
  deactivateValidationDefinition: (kind: DefinitionKind) => void;
  validationRuleSetDraft: RuleSetFile | null;
  validationRuleSetEditing: boolean;
  setValidationRuleSetDraft: (file: RuleSetFile) => void;
  setValidationRuleSetEditing: (editing: boolean) => void;
  clearValidationRuleSetDraft: () => void;
}

export const createValidationDraftSlice: StateCreator<ValidationDraftSlice & IDSSlice, [], [], ValidationDraftSlice> = (set, get) => {
  const loaded = loadDefinitionLibrary();
  const first = activeDefinition(loaded.library, 'rules');
  function commit(library: DefinitionLibrary): boolean {
    const error = checkDefinitionLibrary(library);
    if (error) { set({ validationDefinitionsError: error }); return false; }
    set({ validationDefinitions: library,
      validationDefinitionsError: saveDefinitionLibrary(library, get().validationDefinitionsWritable) });
    return true;
  }
  function project(kind: DefinitionKind): void {
    const entry = activeDefinition(get().validationDefinitions, kind);
    get().clearIdsValidationReport();
    set({ validationDefinitionRevision: get().validationDefinitionRevision + 1, idsLoading: false, idsProgress: null });
    if (kind === 'rules') set({ validationRuleSetDraft: entry?.kind === 'rules' ? entry.file : null, validationRuleSetEditing: true });
    else {
      get().setIdsDocument(entry?.kind === 'ids' ? entry.document : null);
      set({ idsAuditing: false });
    }
  }
  return {
  validationDefinitions: loaded.library,
  validationDefinitionsError: loaded.error,
  validationDefinitionsWritable: loaded.writable,
  validationDefinitionRevision: 0,
  addValidationDefinition: (definition, existingId) => {
    const library = get().validationDefinitions;
    const existing = existingId ? library.entries.find(entry => entry.id === existingId && entry.kind === definition.kind) : undefined;
    if (existingId && !existing) return false;
    const entry: ValidationDefinition = { ...definition, id: existingId ?? crypto.randomUUID() };
    const next = { ...library, entries: existing ? library.entries.map(candidate => candidate.id === existing.id ? entry : candidate) : [...library.entries, entry],
      active: { ...library.active, [entry.kind]: entry.id } };
    if (!commit(next)) return false;
    project(entry.kind);
    return true;
  },
  selectValidationDefinition: (id) => {
    const library = get().validationDefinitions;
    const entry = library.entries.find(candidate => candidate.id === id);
    if (!entry) return;
    if (commit({ ...library, active: { ...library.active, [entry.kind]: id } })) project(entry.kind);
  },
  removeValidationDefinition: (id) => {
    const library = get().validationDefinitions;
    const entry = library.entries.find(candidate => candidate.id === id);
    if (!entry) return;
    const entries = library.entries.filter(candidate => candidate.id !== id);
    const replacing = library.active[entry.kind] === id;
    const active = replacing ? { ...library.active, [entry.kind]: entries.find(candidate => candidate.kind === entry.kind)?.id ?? null } : library.active;
    if (commit({ ...library, entries, active }) && replacing) project(entry.kind);
  },
  deactivateValidationDefinition: (kind) => {
    const library = get().validationDefinitions;
    if (commit({ ...library, active: { ...library.active, [kind]: null } })) project(kind);
  },
  validationRuleSetDraft: first?.kind === 'rules' ? first.file : null,
  validationRuleSetEditing: false,
  setValidationRuleSetDraft: (file) => {
    const library = get().validationDefinitions;
    const active = activeDefinition(library, 'rules');
    if (!active) { get().addValidationDefinition({ kind: 'rules', file }); return; }
    const entries = library.entries.map(entry => entry.id === active.id ? { id: entry.id, kind: 'rules' as const, file } : entry);
    if (commit({ ...library, entries })) set({ validationRuleSetDraft: file, validationDefinitionRevision: get().validationDefinitionRevision + 1 });
  },
  setValidationRuleSetEditing: (editing) => set({ validationRuleSetEditing: editing }),
  clearValidationRuleSetDraft: () => {
    const library = get().validationDefinitions;
    // Closing the editor deactivates its draft, not an IDS report that may
    // be displayed in the same panel. The saved definitions remain reusable.
    if (commit({ ...library, active: { ...library.active, rules: null } })) set({
      validationRuleSetDraft: null, validationRuleSetEditing: false,
      validationDefinitionRevision: get().validationDefinitionRevision + 1,
    });
  },
}; };

export const validationDraftTeardown = defineSliceTeardown(
  'validationDraftSlice',
  // The persisted definition library and its monotonic completion owner
  // survive model/session changes, like the manual checklist library.
  ['validationRuleSetDraft', 'validationRuleSetEditing'],
  {
    'session-reset': notApplicable,
    'model-removed': notApplicable,
    'all-models-cleared': () => ({ validationRuleSetDraft: null, validationRuleSetEditing: false }),
  },
);
