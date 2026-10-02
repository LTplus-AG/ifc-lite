/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Data validation panel's "Manual validation" tab (#6401): the entry
 * body, the checklist editor, verdict controls, comments and the rings.
 * Checklist, group and check names are user content and stay uncatalogued.
 */
export const manualValidationEn = {
  'manualValidation.entry.title': 'Manual validation',
  'manualValidation.entry.description': 'Work through a checklist by eye and record Pass, Fail or Warning with a comment for each check.',
  'manualValidation.entry.new': 'New checklist',
  'manualValidation.entry.open': 'Open .checklist.json',
  'manualValidation.entry.recent': 'Recent checklists',

  'manualValidation.library.select': 'Select checklist',
  'manualValidation.library.none': 'No checklist selected',
  'manualValidation.library.duplicate': 'New from this checklist',
  'manualValidation.library.copyName': '{name} (copy)',
  'manualValidation.library.remove': 'Delete checklist',
  'manualValidation.library.progress': '{completed}/{total} completed ({percent}%)',

  'manualValidation.name.label': 'Checklist name',
  'manualValidation.name.placeholder': 'Untitled checklist',
  'manualValidation.edit': 'Edit checklist',
  'manualValidation.doneEditing': 'Done editing',
  'manualValidation.save': 'Save .checklist.json',
  'manualValidation.close': 'Close checklist',

  'manualValidation.reuse.editCopy': 'Edit a copy',
  'manualValidation.reuse.noIdentity': 'This report has no recorded model identity. Its saved evidence is retained.',
  'manualValidation.reuse.modelNotLoaded': 'Load the recorded model to edit these answers. The saved evidence is retained.',
  'manualValidation.reuse.invalid': 'This saved report cannot be recovered as an editable checklist. Its saved evidence is retained.',

  'manualValidation.model.label': 'Model',
  'manualValidation.model.none': 'Load a model to record verdicts. Answers are stored per model.',
  'manualValidation.model.noIdentity': 'This model has no stable identity yet, so verdicts cannot be recorded for it.',

  'manualValidation.overall': 'Overall',
  'manualValidation.empty': 'This checklist has no groups yet. Add a group, then add the checks it contains.',
  'manualValidation.emptyGroup': 'No checks in this group yet.',

  'manualValidation.group.add': 'Add group',
  'manualValidation.group.defaultName': 'New group',
  'manualValidation.group.nameLabel': 'Group name',
  'manualValidation.group.moveUp': 'Move group up',
  'manualValidation.group.moveDown': 'Move group down',
  'manualValidation.group.remove': 'Delete group',
  'manualValidation.group.progress': '{answered} of {total} checked',

  'manualValidation.item.add': 'Add check',
  'manualValidation.item.textLabel': 'What was checked',
  'manualValidation.item.textPlaceholder': 'Describe the check',
  'manualValidation.item.descriptionLabel': 'Guidance (optional)',
  'manualValidation.item.moveUp': 'Move check up',
  'manualValidation.item.moveDown': 'Move check down',
  'manualValidation.item.remove': 'Delete check',
  'manualValidation.item.untitled': 'Untitled check',
  'manualValidation.item.verdictGroup': 'Verdict for {check}',
  'manualValidation.item.commentLabel': 'Comment on {check}',
  'manualValidation.item.commentPlaceholder': 'Comment (optional)',

  'manualValidation.verdict.pass': 'Pass',
  'manualValidation.verdict.fail': 'Fail',
  'manualValidation.verdict.warning': 'Warning',
  'manualValidation.verdict.unanswered': 'Not checked',

  'manualValidation.ring.label': '{name}: {pass} passed, {warning} with warnings, {fail} failed, {unanswered} not checked',
  'manualValidation.ring.empty': '{name}: no checks',

  'manualValidation.error.invalidFile': '"{name}" is not a valid checklist: {detail}',
  'manualValidation.error.corruptRecent': '"{name}" could not be loaded — it may be corrupted. It has been removed from Recent checklists.',
  'manualValidation.error.notSaved': 'Browser storage refused the change, so it will not survive a reload.',
  'manualValidation.error.noChecklist': 'Select a checklist before recording a verdict or comment. The change was not saved.',

  // The manual report document block (#6401): DocumentPanel.tsx, BlockEditor.tsx, ManualReportPreview.tsx.
  'manualValidation.report.kind': 'Manual validation report',
  'manualValidation.report.add': 'Manual validation report',
  'manualValidation.report.heading': 'Manual validation: {name}',
  'manualValidation.report.unavailableTitle': 'Create or open a checklist under Data validation → Manual validation first',
  'manualValidation.report.sourceLabel': 'Checklist',
  'manualValidation.report.checklistMissing': 'This checklist was deleted. The embedded report is retained.',
  'manualValidation.report.layout': 'Checklist layout',
  'manualValidation.report.long': 'Long',
  'manualValidation.report.compact': 'Short',
  'manualValidation.report.benchmarks': 'Show benchmark scores',
  'manualValidation.report.showStamp': 'Show stamp information',
  'manualValidation.report.modelLabel': 'Answers from',
  'manualValidation.report.modelNotLoaded': 'The model these answers were recorded against ({model}) is not loaded. Load it to refresh, or pick another model.',
  'manualValidation.report.modelNotLoadedUnnamed': 'The model these answers were recorded against is not loaded. Load it to refresh, or pick another model.',
  'manualValidation.report.pickModel': 'Pick a model to refresh from',
  'manualValidation.report.refresh': 'Refresh from current checklist',
  'manualValidation.report.refreshed': 'Refreshed from the current checklist',
  'manualValidation.report.recordedAt': 'Recorded: {timestamp}',
  'manualValidation.report.recordedAtModel': 'Model: {model} · Recorded: {timestamp}',
  'manualValidation.report.passed': '{percent}% passed ({pass} of {total} checks)',
  'manualValidation.report.noGroups': 'No checks in this checklist.',
  'manualValidation.report.untitledGroup': 'Untitled group',
} as const;
