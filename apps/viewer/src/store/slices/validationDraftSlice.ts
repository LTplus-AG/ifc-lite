/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RuleSetFile } from '@ifc-lite/rules';
import type { StateCreator } from 'zustand';
import { defineSliceTeardown, notApplicable } from '../teardown.js';

/** The unsaved Information validation editor survives sidebar unmounts. */
export interface ValidationDraftSlice {
  validationRuleSetDraft: RuleSetFile | null;
  validationRuleSetEditing: boolean;
  setValidationRuleSetDraft: (file: RuleSetFile) => void;
  setValidationRuleSetEditing: (editing: boolean) => void;
  clearValidationRuleSetDraft: () => void;
}

export const createValidationDraftSlice: StateCreator<ValidationDraftSlice, [], [], ValidationDraftSlice> = (set) => ({
  validationRuleSetDraft: null,
  validationRuleSetEditing: false,
  setValidationRuleSetDraft: (file) => set({ validationRuleSetDraft: file }),
  setValidationRuleSetEditing: (editing) => set({ validationRuleSetEditing: editing }),
  clearValidationRuleSetDraft: () => set({ validationRuleSetDraft: null, validationRuleSetEditing: false }),
});

export const validationDraftTeardown = defineSliceTeardown(
  'validationDraftSlice',
  ['validationRuleSetDraft', 'validationRuleSetEditing'],
  {
    'session-reset': notApplicable,
    'model-removed': notApplicable,
    'all-models-cleared': () => ({ validationRuleSetDraft: null, validationRuleSetEditing: false }),
  },
);
