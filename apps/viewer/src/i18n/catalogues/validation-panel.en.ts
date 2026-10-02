/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ValidationPanel` chrome (#5138 PR 4): the panel title, the empty-state
 * entry cards, the rule-set authoring/running states, the set-level result
 * rows (`IDSResultRows.tsx`'s `SetResultRow`) and the closed
 * `FailureReasonCode` labels. `ids-panel.en.ts` keeps every IDS-only
 * string (IDS document load/audit/run, the results toolbar, entity/
 * requirement rows) — this catalogue is additive to it, not a replacement.
 */
export const validationPanelEn = {
  'validationPanel.title': 'Data validation',

  'validationPanel.entry.idsTitle': 'IDS validation',
  'validationPanel.entry.idsDescription': 'Check the model against a buildingSMART IDS requirements file.',
  'validationPanel.entry.rulesTitle': 'Information validation',
  'validationPanel.entry.rulesDescription': 'Author checks — uniqueness, totals, comparisons — the model must satisfy.',
  'validationPanel.entry.newRuleSet': 'New rule set',
  'validationPanel.entry.openRuleSet': 'Open .rules.json',
  'validationPanel.entry.recent': 'Recent rule sets',
  'validationPanel.entry.importIds': 'Import IDS as rules',

  'validationPanel.toggle.ids': 'IDS validation',
  'validationPanel.toggle.rules': 'Information validation',
  'validationPanel.toggle.manual': 'Manual validation',

  'validationPanel.editRules': 'Edit rules',
  'validationPanel.save': 'Save',
  'validationPanel.exportIds': 'Export as IDS',

  'validationPanel.idsExport.summary': 'Exported {converted} of {total} rules to IDS.',
  'validationPanel.idsExport.none': 'No rule in this set can be expressed in IDS, so nothing was exported.',
  'validationPanel.idsExport.refusedHeading': 'Not exported',
  'validationPanel.idsImport.summary': 'Imported {converted} of {total} IDS specifications as rules.',
  'validationPanel.idsImport.none': 'No specification in this IDS has a rule equivalent, so nothing was imported.',
  'validationPanel.idsImport.refusedHeading': 'Not imported',
  'validationPanel.idsImport.droppedHeading': 'Imported without these checks',
  'validationPanel.idsSummary.notesHeading': 'Note',
  'validationPanel.idsSummary.dismiss': 'Dismiss',
  'validationPanel.run': 'Run',
  'validationPanel.cancel': 'Cancel',

  'validationPanel.running.rule': 'Checking rule {current} of {total}',
  'validationPanel.running.applicability': 'Finding applicable elements…',
  'validationPanel.running.requirements': 'Checking requirements…',

  'validationPanel.results.validatedAgainst': 'Validated against: {models}',

  'validationPanel.error.validationFailed': 'Validation failed',
  'validationPanel.error.corruptRecent': '"{name}" could not be loaded — it may be corrupted. It has been removed from Recent rule sets.',

  'validationPanel.setResult.heading': 'Set-level results',
  'validationPanel.setResult.actualExpected': '{actual} (expected {expected})',
  'validationPanel.setResult.members': { one: '{countDisplay} member', other: '{countDisplay} members' },
  'validationPanel.setResult.isolate': 'Isolate',
  'validationPanel.setResult.truncated': 'Some set results were omitted — too many to list.',
  'validationPanel.setResult.duplicateGroupsSummary': { one: '{countDisplay} duplicate group', other: '{countDisplay} duplicate groups' },
  'validationPanel.setResult.aggregateFailuresSummary': { one: '{countDisplay} aggregate check failed', other: '{countDisplay} aggregate checks failed' },

  'validationPanel.reason.absent': 'Value is absent',
  'validationPanel.reason.mismatch': 'Value does not match',
  'validationPanel.reason.notNumeric': 'Value is not numeric',
  'validationPanel.reason.cardinality': 'Cardinality not satisfied',
  'validationPanel.reason.duplicate': 'Duplicate value',
  'validationPanel.reason.aggregate': 'Aggregate check failed',
  'validationPanel.reason.notDate': 'Value is not a date',
  'validationPanel.history.title': 'Saved reports',
  'validationPanel.history.select': 'Select saved validation report',
  'validationPanel.history.name': 'Report name',
  'validationPanel.history.remove': 'Remove report',
  'validationPanel.history.frozen': 'Saved evidence. Later runs do not change this report.',
  'validationPanel.history.models': 'Models: {models}',
  'validationPanel.history.empty': 'Choose Save report after an IDS or information check to keep it here. Save a manual report from its checklist.',
  'validationPanel.history.saveReport': 'Save report',
  'validationPanel.history.saved': 'Report saved',
  'validationPanel.history.savePending': 'Save pending',
  'validationPanel.history.saveRejected': 'This report could not be saved.',
  'validationPanel.history.recovered': '{subject}: some entries could not be read. The original data was preserved; valid entries remain available.',
  'validationPanel.history.blocked': '{subject}: damaged data could not be backed up. Saving is blocked to protect the original. Retry when browser storage is available.',
  'validationPanel.history.unavailable': '{subject}: browser storage could not be read or updated. Keep this page open and retry saving.',
  'validationPanel.history.retrySave': 'Retry save',
  'validationPanel.history.unsaved': 'Reports are available in this session, but storage refused the save. They will be lost on reload.',
  'validationPanel.history.saveManual': 'Save report',
  'validationPanel.history.documentSource': 'Saved report source',
  'validationPanel.history.embedded': 'Current document snapshot',
  'validationPanel.history.addDocument': 'Saved validation report',
  'validationPanel.library.rulesSelect': 'Select rule set',
  'validationPanel.library.idsSelect': 'Select IDS document',
  'validationPanel.library.none': 'No check selected',
  'validationPanel.library.untitled': 'Untitled check',
  'validationPanel.library.new': 'New rule set',
  'validationPanel.library.import': 'Import another check',
  'validationPanel.library.copy': 'New from this check',
  'validationPanel.library.copyName': '{name} copy',
  'validationPanel.library.delete': 'Delete check',
  'validationPanel.library.idsDownload': 'Download IDS',
} as const;
