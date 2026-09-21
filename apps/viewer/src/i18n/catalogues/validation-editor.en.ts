/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The information-validation rule editor (#5138 PR 5):
 * `validation/RuleSetEditor.tsx`, `RuleSetEditor.ruleCard.tsx`,
 * `RuleSetEditor.requirementEditor.tsx`, `RuleBlockEditor.tsx`,
 * `FoldedGroupEditor.tsx`, `SubjectPicker.tsx`, `RuleModelPicker.tsx`.
 *
 * `ids-panel.en.ts` keeps every IDS-only string; this catalogue is the
 * rule-based ("Information validation") side only. Not reachable from the
 * running app yet — no panel registers these components (PR 4's job) — so
 * every key here is exercised only by this PR's own component tests.
 */
export const validationEditorEn = {
  'validationEditor.requirementKind.element': 'Element',
  'validationEditor.requirementKind.unique': 'Unique',
  'validationEditor.requirementKind.aggregate': 'Aggregate',
  'validationEditor.requirementKind.compare': 'Compare',

  'validationEditor.severity.error': 'Error',
  'validationEditor.severity.warning': 'Warning',

  'validationEditor.ruleSetEditor.namePlaceholder': 'Rule set name',
  'validationEditor.ruleSetEditor.nameAriaLabel': 'Rule set name',
  'validationEditor.ruleSetEditor.descriptionPlaceholder': 'Description (optional)',
  'validationEditor.ruleSetEditor.descriptionAriaLabel': 'Rule set description',
  'validationEditor.ruleSetEditor.targets': 'Target models',
  'validationEditor.ruleSetEditor.emptyRulesHint': 'No rules yet — add one to start.',
  'validationEditor.ruleSetEditor.addRule': 'Add rule',

  'validationEditor.ruleCard.namePlaceholder': 'Rule name',
  'validationEditor.ruleCard.nameAriaLabel': 'Rule name',
  'validationEditor.ruleCard.descriptionPlaceholder': 'Description (optional)',
  'validationEditor.ruleCard.descriptionAriaLabel': 'Rule description',
  'validationEditor.ruleCard.removeAriaLabel': 'Remove rule "{name}"',
  'validationEditor.ruleCard.applicability': 'Applies to',
  'validationEditor.ruleCard.requirement': 'Requirement',
  'validationEditor.ruleCard.advanced': 'Advanced',
  'validationEditor.ruleCard.caseSensitive': 'Case sensitive',
  'validationEditor.ruleCard.tolerance': 'Tolerance',
  'validationEditor.ruleCard.cardinalityMin': 'Min applicable',
  'validationEditor.ruleCard.cardinalityMax': 'Max applicable',
  'validationEditor.ruleCard.cardinalityAny': 'any',

  'validationEditor.ruleBlockEditor.chipsMode': 'Chips',
  'validationEditor.ruleBlockEditor.selectorMode': 'Selector text',
  'validationEditor.ruleBlockEditor.exactClassNotice': 'Contains an exact-class rule — selector text can’t express this.',

  'validationEditor.betweenChip.label': 'Between',
  'validationEditor.betweenChip.and': 'and',
  'validationEditor.betweenChip.minAriaLabel': 'Range minimum',
  'validationEditor.betweenChip.maxAriaLabel': 'Range maximum',

  'validationEditor.subjectPicker.attributeNamePlaceholder': 'Attribute name',
  'validationEditor.subjectPicker.psetNamePlaceholder': 'Property set',
  'validationEditor.subjectPicker.propertyNamePlaceholder': 'Property',
  'validationEditor.subjectPicker.qsetNamePlaceholder': 'Quantity set',
  'validationEditor.subjectPicker.quantityNamePlaceholder': 'Quantity',
  'validationEditor.subjectPicker.classificationSystemPlaceholder': 'Classification system (optional)',

  'validationEditor.unique.subjectAriaLabel': 'Unique value subject',
  'validationEditor.unique.scope.federation': 'Federation',
  'validationEditor.unique.scope.perModel': 'Per model',

  'validationEditor.aggregate.subjectAriaLabel': 'Aggregate subject',
  'validationEditor.aggregate.groupByToggle': 'Group by',
  'validationEditor.aggregate.groupBySubjectAriaLabel': 'Group by subject',
  'validationEditor.aggregate.universeToggle': 'Define groups from…',

  'validationEditor.compare.leftAriaLabel': 'Compare left subject',
  'validationEditor.compare.rightAriaLabel': 'Compare right subject',
  'validationEditor.compare.valueType.number': 'Number',
  'validationEditor.compare.valueType.date': 'Date',

  'validationEditor.requirementText.ariaLabel': 'Requirement, as text',

  'validationEditor.modelPicker.allModels': 'All models',
  'validationEditor.modelPicker.noFingerprintTitle': 'This model has no stable fingerprint yet and cannot be targeted by a saved rule set.',
  'validationEditor.modelPicker.notLoaded': { one: '{count} selected model is not loaded', other: '{count} selected models are not loaded' },
} satisfies Record<string, TranslationValue>;
