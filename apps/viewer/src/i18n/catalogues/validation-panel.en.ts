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

  'validationPanel.toggle.ids': 'IDS validation',
  'validationPanel.toggle.rules': 'Information validation',

  'validationPanel.editRules': 'Edit rules',
  'validationPanel.save': 'Save',
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
} as const;
