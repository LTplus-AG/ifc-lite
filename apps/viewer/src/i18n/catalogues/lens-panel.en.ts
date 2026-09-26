/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Lens panel's own chrome (#4918 slice: viewer-panels). Covers
 * `LensPanel.tsx`: the header and its export/import/clear/close controls,
 * the rule-based lens list (`RuleRow`, `RuleEditor`, `LensEditor`), the
 * auto-color lens editor (`AutoColorEditor`), the read-only lens card
 * (`LensCard`, its legend sort control and per-lens action tooltips), and
 * the footer status line.
 *
 * Criteria and auto-color source names use the type-label table here;
 * operator names come from the shared filter-operator catalogue (#5892).
 *
 * Deliberately out of scope: the `'New Rule'` default rule name and the
 * `'Color by '` auto-color name prefix are equality-checked SENTINELS this
 * component uses to detect "the user has not renamed this yet" (see the
 * comments at their call sites in `LensPanel.tsx`) before substituting a
 * localized type label — translating the sentinel itself would desync the
 * comparison from the literal it is compared against on any non-English
 * locale, the same reasoning that keeps `bcfHelpers.tsx`'s `TOPIC_TYPES`
 * field values and the clash-panel catalogue's `'Clash report'` project
 * name untranslated. IFC class names, property/quantity/classification/
 * material/model/zone NAMES and VALUES discovered from the loaded model
 * remain runtime data throughout.
 */
export const lensPanelEn = {
  'lensPanel.title': 'Lens',
  'lensPanel.exportTooltip': 'Export lenses as JSON',
  'lensPanel.importTooltip': 'Import lenses from JSON',
  'lensPanel.clearButton': 'Clear',
  'lensPanel.closeAriaLabel': 'Close',
  'lensPanel.newRuleLensButton': 'New Rule Lens',
  'lensPanel.newAutoColorLensButton': 'New Auto-Color Lens',
  'lensPanel.emptyTitle': 'No lenses yet',
  'lensPanel.emptyDescription': 'Create a lens to color or focus model elements.',

  // Footer status
  'lensPanel.footer.active': 'Active · {colored} colored · {hidden}',
  'lensPanel.footer.hiddenCount': { one: '{count} hidden', other: '{count} hidden' },
  'lensPanel.footer.ghosted': 'ghosted',
  'lensPanel.footer.clickToActivate': 'Click a lens to activate',

  // Shared type labels (rule criteria types / auto-color sources)
  'lensPanel.type.ifcType': 'IFC Class',
  'lensPanel.type.attribute': 'Attribute',
  'lensPanel.type.property': 'Property',
  'lensPanel.type.quantity': 'Quantity',
  'lensPanel.type.classification': 'Classification',
  'lensPanel.type.material': 'Material',
  'lensPanel.type.model': 'Model',
  'lensPanel.type.group': 'Zone / Group',

  // Rule row (read-only, clickable for isolation)
  'lensPanel.ruleRow.isolateTooltip': 'Click to isolate / show only this group',
  'lensPanel.ruleRow.emptyTooltip': 'No matching entities',
  'lensPanel.isolatedBadge': 'isolated',

  // Auto-color legend row
  'lensPanel.autoColorRow.isolateTooltip': 'Click to isolate / show only this value',

  // Rule editor
  'lensPanel.ruleEditor.reorderAriaLabel': 'Reorder rule: drag, or press arrow up or down',
  'lensPanel.ruleEditor.reorderTooltip': 'Drag to reorder (or arrow keys)',
  'lensPanel.ruleEditor.compoundTypeAriaLabel': 'Compound criteria type (read-only, imported)',
  'lensPanel.ruleEditor.criteriaTypeAriaLabel': 'Criteria type',
  'lensPanel.ruleEditor.compoundReadOnlyTooltip':
    'Compound rules are imported read-only; this panel does not yet support editing them.',
  'lensPanel.ruleEditor.classPlaceholder': 'Class...',
  'lensPanel.ruleEditor.attributeValuePlaceholder': 'value...',
  'lensPanel.ruleEditor.materialPlaceholder': 'Material...',
  'lensPanel.ruleEditor.noModelsLoaded': 'No models loaded',
  'lensPanel.ruleEditor.modelFallbackLabel': 'Model',
  'lensPanel.ruleEditor.modelSelectPlaceholder': 'Model...',
  'lensPanel.ruleEditor.groupPlaceholder': 'Zone / group name (blank = any)',
  'lensPanel.ruleEditor.duplicateTooltip': 'Duplicate rule',
  'lensPanel.ruleEditor.removeTooltip': 'Remove rule',
  'lensPanel.ruleEditor.propertySetPlaceholder': 'Property set...',
  'lensPanel.ruleEditor.propertyNamePlaceholder': 'Property...',
  'lensPanel.ruleEditor.quantitySetPlaceholder': 'Quantity set...',
  'lensPanel.ruleEditor.quantityNamePlaceholder': 'Quantity...',
  'lensPanel.ruleEditor.classificationSystemPlaceholder': 'System...',
  'lensPanel.ruleEditor.classificationCodePlaceholder': 'Code...',
  'lensPanel.ruleEditor.valuePlaceholder': 'Value...',

  // Rule action (`LensRule['action']`)
  'lensPanel.action.colorize': 'Color',
  'lensPanel.action.transparent': 'Transp',
  'lensPanel.action.hide': 'Hide',

  // Rule-based lens editor
  'lensPanel.editor.namePlaceholder': 'Lens name...',
  'lensPanel.editor.addRule': 'Add Rule',
  'lensPanel.editor.save': 'Save',
  'lensPanel.editor.cancel': 'Cancel',

  // Auto-color lens editor
  'lensPanel.autoColor.namePlaceholder': 'Auto-color lens name...',
  'lensPanel.autoColor.byDistinctValues': 'Auto-color by distinct values',
  'lensPanel.autoColor.sourceLabel': 'Source',
  'lensPanel.autoColor.psetLabel': 'Pset',
  'lensPanel.autoColor.systemLabel': 'System',
  'lensPanel.autoColor.qsetLabel': 'Qset',
  'lensPanel.autoColor.selectPropertySetPlaceholder': 'Select property set...',
  'lensPanel.autoColor.selectSystemPlaceholder': 'Select system...',
  'lensPanel.autoColor.selectQuantitySetPlaceholder': 'Select quantity set...',
  'lensPanel.autoColor.nameLabel': 'Name',
  'lensPanel.autoColor.selectPlaceholderOption': 'Select...',
  'lensPanel.autoColor.selectPropertyPlaceholder': 'Select property...',
  'lensPanel.autoColor.selectQuantityPlaceholder': 'Select quantity...',
  'lensPanel.autoColor.showUnclassified': 'Show unclassified',

  // Lens card (read-only display)
  'lensPanel.card.sortCount': 'Count',
  'lensPanel.card.sortNameAsc': 'A→Z',
  'lensPanel.card.sortNameDesc': 'Z→A',
  'lensPanel.card.duplicateBuiltinTooltip': 'Duplicate into an editable copy',
  'lensPanel.card.duplicateTooltip': 'Duplicate lens',
  'lensPanel.card.editTooltip': 'Edit lens',
  'lensPanel.card.deleteTooltip': 'Delete lens',
  'lensPanel.card.ruleCount': { one: '{count} rule', other: '{count} rules' },
  'lensPanel.card.legendValuesCount': { one: '{count} value', other: '{count} values' },
  'lensPanel.card.sortLegendTooltip': 'Sort legend entries',
} as const;
