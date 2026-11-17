/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export const coreControlInventory = [
  { owner: 'viewport', controls: [
    { control: 'Native numerical cut box/face plane, plane library, cap style/display and Undo', operations: ['section.nativeState', 'section.box', 'section.facePlane', 'section.customDistance', 'section.managePlane', 'section.capStyle', 'section.display', 'section.history'] },
    { control: 'Numerical free/anchored annotation placement and expected-snapshot edit/delete/select', operations: ['annotations.read', 'annotations.create', 'annotations.createAnchored', 'annotations.manage'] },
  ], notes: ['Native renderer ownership, effective visibility and clip state govern point/surface picking.'] },
  { owner: 'properties', controls: [
    { control: 'Effective entity/properties/material/classification/relationship/unit inspection', operations: ['entity.inspect', 'entities.inspect', 'properties.unique', 'materials.list', 'classifications.list', 'entity.relationships', 'units.read', 'preferences.unitOptions', 'preferences.unitOverride', 'preferences.unitReset'] },
  ], notes: [] },
  { owner: 'search', controls: [
    { control: 'Native Rules/text/captured-scope configuration, presets, evaluation/result pages and CSV/JSON artifacts', operations: ['filters.state', 'filters.configure', 'filters.run', 'filters.results', 'filters.preset', 'filters.export', 'fields.schema', 'fields.properties', 'fields.values'] },
  ], notes: ['Search-result selection/isolation uses the same native model-qualified selection, visibility and basket adapters.'] },
  { owner: 'hierarchy', controls: [
    { control: 'Effective model/entity/spatial/containment queries and native field/value discovery', operations: ['models.list', 'entities.query', 'hierarchy.tree', 'entity.containment', 'fields.schema', 'fields.properties', 'fields.values'] },
    { control: 'Model activation, visibility and safe unload through native teardown', operations: ['model.activate', 'model.visibility', 'model.unload'] },
    { control: 'Native grouping, selection and visibility; basket sources, replace/add/remove/clear and isolation', operations: ['hierarchy.mode', 'selection.read', 'selection.replace', 'selection.clear', 'visibility.hide', 'visibility.show', 'visibility.isolate', 'visibility.reset', 'basket.read', 'basket.replace', 'basket.add', 'basket.remove', 'basket.hierarchySource', 'basket.clear', 'basket.show'] },
  ], notes: ['Native unload of a model with unexported changes retains the existing discard-confirmation dialog.', 'Tree expansion, local search, row sorting, scroll position and resizing are panel presentation state; domain queries and target operations are available independently.'] },
  { owner: 'preferences', controls: [
    { control: 'Theme, navigation, wheel, load-time geometry, layer merge and display settings', operations: ['preferences.read', 'preferences.theme', 'preferences.navigation', 'preferences.wheel', 'preferences.geometry', 'preferences.mergeLayers', 'preferences.performanceStats', 'preferences.visualEnhancements', 'preferences.centreline', 'preferences.ribbonCollapsed', 'preferences.ribbonContext', 'preferences.tooltips'] },
    { control: 'Curated display-unit alternatives, per-type override and reset', operations: ['preferences.unitOptions', 'preferences.unitOverride', 'preferences.unitReset'] },
  ], notes: ['Layout/shortcut chrome is available through native palette commands and flavor capture/switch; drag/resize feedback is presentation.'] },
  { owner: 'changes', controls: [
    { control: 'Native full changed-model STEP/IFCX/portable appearance export and multiple-model ZIP bundling, with schedule attribution and skip diagnostics', operations: ['exports.changedModels'] },
  ], notes: ['Other native export formats and exact credential/publication boundaries are listed by the finite toolbar export inventory.'] },
] as const;
