/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Filter tab's chip-editing surfaces (#4918 slice), split out of the
 * sibling `search-modal.en.ts` purely to keep both files under the
 * module-size budget — both share the `searchModal.*` prefix. Covers the
 * rule-builder toolbar and preset menu (`SearchModal.filter.builder.tsx`),
 * every per-kind rule chip editor (`SearchModal.filter.editors.tsx` and its
 * split-out `.elevation.tsx` / `.identity.tsx` siblings), and the selector
 * text field (`SearchModal.filter.selector.tsx`).
 *
 * Field/property/pset/quantity NAME examples inside placeholders
 * (`Pset_WallCommon`, `Qto_WallBaseQuantities`, `SOLIDWALL`, …) are kept as
 * part of the translatable guidance text itself — they illustrate the
 * selector/rule syntax a user types, not a rendered schema attribute name,
 * so unlike a `GeorefRow` label elsewhere in this sweep they are not this
 * house rule's "IFC EXPRESS name" exemption.
 */
export const searchFiltersEn = {
  // ── SearchModal.filter.builder.tsx ────────────────────────────────────
  'searchModal.filterBuilder.noRuleMapped': 'Nothing in that selector maps to a filter rule yet: {unsupported}',
  'searchModal.filterBuilder.unionNotSupported':
    '"{query}" unions {groupCount} groups with "+" — use the Selector field above to apply the whole union; this button only ever adds into one group.',
  'searchModal.filterBuilder.addedWithoutParts': 'Added without these parts: {unsupported}',
  'searchModal.filterBuilder.saveFilterPrompt': 'Save filter as…',
  'searchModal.filterBuilder.saveFilterFailed': 'Filter could not be saved — browser storage is unavailable or full.',
  'searchModal.filterBuilder.deleteFilterFailed': 'Filter could not be deleted — browser storage is unavailable or full.',
  'searchModal.filterBuilder.limitLabel': 'Limit',
  'searchModal.filterBuilder.limitZeroHint': '0 = none',
  'searchModal.filterBuilder.promoteQueryTitle': 'Turn the search bar query into filter rules',
  'searchModal.filterBuilder.addQueryAsRule': 'Add “{query}” as rule',
  'searchModal.filterBuilder.savePresetTitle': 'Save the current rules as a named preset',
  'searchModal.filterBuilder.save': 'Save',
  'searchModal.filterBuilder.reset': 'Reset',
  'searchModal.filterBuilder.emptyRulesHint':
    'Add a rule to start filtering — pick by model, storey, IFC type, name, property, quantity, material, classification, or elevation.',
  'searchModal.filterBuilder.savePresetFirstTitle': 'Save a preset first',
  'searchModal.filterBuilder.presets': 'Presets',
  'searchModal.filterBuilder.savedPresets': 'Saved presets',
  'searchModal.filterBuilder.presetRuleCount': { one: '{count} rule', other: '{count} rules' },
  'searchModal.filterBuilder.deletePresetAriaLabel': 'Delete preset {name}',

  // ── SearchModal.filter.editors.tsx / .elevation.tsx / .identity.tsx ──
  'searchModal.filterEditors.removeRuleAriaLabel': 'Remove rule',
  'searchModal.filterEditors.pickValues': 'Pick values…',
  'searchModal.filterEditors.selectedCount': { one: '{count} selected', other: '{count} selected' },
  'searchModal.filterEditors.noOptionsAvailable': 'No options available — load a model first.',
  'searchModal.filterEditors.removeValueAriaLabel': 'Remove {value}',
  'searchModal.filterEditors.predefinedTypePlaceholder': 'e.g. SOLIDWALL, PARTITIONING',
  'searchModal.filterEditors.pick': 'Pick',
  'searchModal.filterEditors.textPlaceholder': 'text',
  'searchModal.filterEditors.psetNamePlaceholder': 'Pset_… (e.g. Pset_WallCommon)',
  'searchModal.filterEditors.propertyNamePlaceholder': 'prop name',
  'searchModal.filterEditors.valuePlaceholder': 'value',
  'searchModal.filterEditors.qsetNamePlaceholder': 'Qto_… (e.g. Qto_WallBaseQuantities)',
  'searchModal.filterEditors.quantityNamePlaceholder': 'quantity name',
  'searchModal.filterEditors.materialNamePlaceholder': 'material name (e.g. Concrete)',
  'searchModal.filterEditors.classificationSystemPlaceholder': 'system (optional)',
  'searchModal.filterEditors.classificationSystemAriaLabel': 'Classification system — leave blank for any',
  'searchModal.filterEditors.classificationValuePlaceholder': 'code or name',
  'searchModal.filterEditors.elevationPlaceholder': 'metres',
  'searchModal.filterEditors.elevationUnitHint': 'm (storey elevation)',
  'searchModal.filterEditors.globalIdPlaceholder': 'e.g. 325Q7Fhnf67OZC$$r43uzK',
  'searchModal.filterEditors.attributeNamePlaceholder': 'Description, ObjectType, Tag, …',

  // ── SearchModal.filter.selector.tsx ───────────────────────────────────
  'searchModal.filterSelector.nothingMapped': 'Nothing in this selector maps to a filter rule yet:',
  'searchModal.filterSelector.appliedWithoutParts': 'Applied without these parts:',
  'searchModal.filterSelector.placeholder': 'IfcWall, Pset_WallCommon.FireRating=/REI.*/',
  'searchModal.filterSelector.inputAriaLabel': 'Selector syntax',
  'searchModal.filterSelector.applyTitle': 'Replace the rules below with this selector',
  'searchModal.filterSelector.apply': 'Apply',
  'searchModal.filterSelector.docsAriaLabel': 'Selector syntax reference',
} satisfies Record<string, TranslationValue>;
