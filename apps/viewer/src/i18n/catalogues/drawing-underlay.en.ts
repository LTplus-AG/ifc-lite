/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The drawing-underlay feature (#4918 slice: keyboard shortcuts + drawing
 * underlay) covers two siblings under one `drawingUnderlay.*` namespace
 * because they are the same 2D-drawing-overlay feature: `settings.*` is
 * `DrawingSettingsPanel.tsx`'s graphic-override presets and custom-rule
 * editor (issue-tracked drawing graphic styles), and `dxf.*` is
 * `DxfUnderlayPanel.tsx`'s imported-DXF reference-underlay manager (issue
 * #1782/#1929/#2043). IFC class NAMES (`COMMON_IFC_TYPES`), line-weight/
 * unit data tables, and DXF layer/file NAMES from the imported drawing are
 * model or registry content and stay out of the catalogue; only the
 * surrounding chrome is translated here.
 */
export const drawingUnderlayEn = {
  // DrawingSettingsPanel
  'drawingUnderlay.settings.overridesEnabled': 'Enabled',
  'drawingUnderlay.settings.overridesDisabled': 'Disabled',
  'drawingUnderlay.settings.presetsHeading': 'Style Presets',
  'drawingUnderlay.settings.activePresetRulesHeading': '{name} Rules',
  'drawingUnderlay.settings.copyToCustomTitle': 'Copy rules to custom for editing',
  'drawingUnderlay.settings.editAsCustomButton': 'Edit as Custom',
  'drawingUnderlay.settings.customRulesHeading': 'Custom Rules',
  'drawingUnderlay.settings.customRulesCount': { one: '{count} rule', other: '{count} rules' },
  'drawingUnderlay.settings.noCustomRules': 'No custom rules yet',
  'drawingUnderlay.settings.addCustomRuleButton': 'Add Custom Rule',
  'drawingUnderlay.settings.clickToEditPlaceholder': 'Click to edit',
  'drawingUnderlay.settings.ruleNameLabel': 'Rule Name',
  'drawingUnderlay.settings.ifcClassLabel': 'IFC Class',
  'drawingUnderlay.settings.selectClassPlaceholder': 'Select class...',
  'drawingUnderlay.settings.fillColorLabel': 'Fill Color',
  'drawingUnderlay.settings.strokeColorLabel': 'Stroke Color',
  'drawingUnderlay.settings.lineWeightLabel': 'Line Weight',
  'drawingUnderlay.settings.customLineWeightOption': 'Custom...',
  'drawingUnderlay.settings.millimetersUnit': 'mm',
  'drawingUnderlay.settings.deleteButton': 'Delete',
  'drawingUnderlay.settings.disableRule': 'Disable {name}',
  'drawingUnderlay.settings.enableRule': 'Enable {name}',
  'drawingUnderlay.settings.doneButton': 'Done',

  // DxfUnderlayPanel
  'drawingUnderlay.dxf.importButton': 'Import DXF...',
  'drawingUnderlay.dxf.emptyStateHint': 'Import a DXF drawing (site plan, survey, coordination set) as a reference layer under the 2D section. You can also drop .dxf files anywhere on the viewport. Underlays render on plan views; use Placement or Center on model to position them.',
  'drawingUnderlay.dxf.notPlanViewHint': 'Underlays render on plan (top-down) sections. Switch the section to a plan view to see them.',
  'drawingUnderlay.dxf.hide2DTitle': 'Hide in 2D drawing view',
  'drawingUnderlay.dxf.show2DTitle': 'Show in 2D drawing view',
  'drawingUnderlay.dxf.badge2D': '2D',
  'drawingUnderlay.dxf.hide3DTitle': 'Hide in 3D view',
  'drawingUnderlay.dxf.show3DTitle': 'Show in 3D view',
  'drawingUnderlay.dxf.centerOnModelTitle': 'Center on model',
  'drawingUnderlay.dxf.centerOnModelDisabledTitle': 'Center on model (switch to a plan view first)',
  'drawingUnderlay.dxf.removeUnderlayTitle': 'Remove underlay',
  'drawingUnderlay.dxf.summaryLine': '{layers} layers · {paths} paths · {texts} texts',
  'drawingUnderlay.dxf.moreWarningsSuffix': ' (+{count} more)',
  'drawingUnderlay.dxf.notImportedLabel': 'Not imported:',
  'drawingUnderlay.dxf.opacityLabel': 'Opacity (2D)',
  'drawingUnderlay.dxf.opacityHint': 'Opacity applies to the 2D drawing only — the 3D view always renders this underlay fully opaque when its 3D toggle is on',
  'drawingUnderlay.dxf.georefToggleLabel': 'Align to model georeference',
  'drawingUnderlay.dxf.georefAutoSuffix': ' (auto)',
  'drawingUnderlay.dxf.georefAutoHint': 'Auto: currently {state} — follows whether the anchor model has a usable georeference. Click to pin this explicitly.',
  'drawingUnderlay.dxf.georefManualHint': "Applies the inverse IfcMapConversion so this DXF's map/CRS coordinates (eastings/northings) line up with the IFC model. Turn off if this DXF is already drawn in the model's local coordinates.",
  'drawingUnderlay.dxf.onState': 'ON',
  'drawingUnderlay.dxf.offState': 'OFF',
  'drawingUnderlay.dxf.layersSectionLabel': 'Layers',
  'drawingUnderlay.dxf.hideLayerTitle': 'Hide layer {name}',
  'drawingUnderlay.dxf.showLayerTitle': 'Show layer {name}',
  'drawingUnderlay.dxf.placementSectionLabel': 'Placement',
} as const satisfies Record<string, TranslationValue>;
