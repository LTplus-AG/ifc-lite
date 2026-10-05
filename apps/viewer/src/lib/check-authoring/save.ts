/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saving reviewed check-authoring drafts (#6915) into the native libraries,
 * and the handoff to their native editors. Every save re-checks the gates the
 * review enforced (native audit, current dry run, current report), so a stale
 * or unaudited draft cannot be saved through a late click.
 */

import { parseIDS, type IDSAuditIssue } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import { downloadFile, sanitizeFilename } from '../export/download';
import { setValidationSourceChoice } from '../validation/validation-source-choice';
import { isDryRunCurrent, type DryRun } from './dry-run';
import type { IdsDraft } from './ids-proposal';
import { ruleSetForSave, type RulesProposal } from './rules-proposal';
import type { DocumentDraft } from './document-outline';

export interface SavedDefinition {
  /** Native definition-library entry id. */
  id: string;
  /** Storage notice when the entry is kept for this session only. */
  warning: string | null;
}

export const auditBlocks = (issues: readonly IDSAuditIssue[] | null): boolean =>
  !issues || issues.some(issue => issue.severity === 'error');

/**
 * Adds a new library entry WITHOUT activating it: activating clears the shown
 * validation report (and, for rules, opens the editor), which may be the very
 * report the conversation was drafted from. `openDefinition` activates it.
 */
function addDefinition(definition: Parameters<ReturnType<typeof useViewerStore.getState>['addValidationDefinition']>[0]): SavedDefinition {
  const state = useViewerStore.getState();
  const before = new Set(state.validationDefinitions.entries.map(entry => entry.id));
  if (!state.addValidationDefinition(definition, undefined, { activate: false })) throw new Error(state.validationDefinitionsError ?? 'The validation library refused the draft.');
  const after = useViewerStore.getState();
  const added = after.validationDefinitions.entries.find(entry => !before.has(entry.id) && entry.kind === definition.kind);
  if (!added) throw new Error('The saved definition is not in its library.');
  return { id: added.id, warning: after.validationDefinitionsError };
}

/** New IDS library entry with the exact reviewed XML; the active IDS and its shown report are unchanged. */
export function saveIdsDraft(draft: IdsDraft, issues: readonly IDSAuditIssue[] | null, run: DryRun | null): SavedDefinition {
  if (!draft.xml) throw new Error('The draft has no specification to save.');
  if (auditBlocks(issues)) throw new Error('Resolve the native IDS audit errors before saving.');
  if (!isDryRunCurrent(run, draft.document)) throw new Error('Dry-run the draft on the current models before saving.');
  return addDefinition({ kind: 'ids', xml: draft.xml, document: parseIDS(draft.xml) });
}

/** New information rule set, not activated; unsupported requirements are kept in its descriptions. */
export function saveRulesDraft(proposal: RulesProposal, run: DryRun | null): SavedDefinition {
  if (!isDryRunCurrent(run, proposal.ruleSet)) throw new Error('Dry-run the rules on the current models before saving.');
  return addDefinition({ kind: 'rules', file: ruleSetForSave(proposal) });
}

/** A new native document, never an overwrite of an existing one. */
export async function saveDocumentDraft(draft: DocumentDraft): Promise<boolean> {
  const current = () => useViewerStore.getState().idsValidationReport === draft.report;
  if (!current()) throw new Error('The validation report changed after the draft was prepared. Prepare it again.');
  await useViewerStore.getState().initializeDocuments();
  if (!current()) throw new Error('The validation report changed while document storage initialized. Prepare the draft again.');
  return useViewerStore.getState().upsertDocument(structuredClone(draft.document));
}

export function exportIdsDraft(draft: IdsDraft, issues: readonly IDSAuditIssue[] | null): void {
  if (!draft.xml || auditBlocks(issues)) throw new Error('Resolve the native IDS audit errors before exporting.');
  downloadFile(draft.xml, `${sanitizeFilename(draft.proposal.title, { fallback: 'ids' })}.ids`, 'application/xml');
}

/** Handoff: the saved definition becomes the panel's active one, on the matching side (this clears the shown report). */
export function openDefinition(kind: 'ids' | 'rules', id: string): void {
  const state = useViewerStore.getState();
  state.selectValidationDefinition(id);
  if (kind === 'rules') state.setValidationRuleSetEditing(true);
  setValidationSourceChoice(kind);
}
