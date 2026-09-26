/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appearanceAssignmentListEn } from './catalogues/appearance-assignment-list.en';
import { appearanceAssignmentMembersEn } from './catalogues/appearance-assignment-members.en';
import { addElementEn } from './catalogues/add-element.en';
import { analysisStaleEn } from './catalogues/analysis-stale.en';
import { annotationsEn } from './catalogues/annotations.en';
import { anonymizedExportEn } from './catalogues/anonymized-export.en';
import { chartsEn } from './catalogues/charts.en';
import { clashPanelEn } from './catalogues/clash-panel.en';
import { appearancePanelEn } from './catalogues/appearance-panel.en';
import { appearancePickersEn } from './catalogues/appearance-pickers.en';
import { appearanceWorkflowsEn } from './catalogues/appearance-workflows.en';
import { bcfEn } from './catalogues/bcf.en';
import { clashGroupsEn } from './catalogues/clash-groups.en';
import { clashToolsEn } from './catalogues/clash-tools.en';
import { bulkPropertyEditorEn } from './catalogues/bulk-property-editor.en';
import { cesiumGeoEn } from './catalogues/cesium-geo.en';
import { chatEn } from './catalogues/chat.en';
import { chatByokEn } from './catalogues/chat-byok.en';
import { commandPaletteEn } from './catalogues/command-palette.en';
import { compareKeyPropertyEn } from './catalogues/compare-key-property.en';
import { comparePanelEn } from './catalogues/compare-panel.en';
import { costPanelEn } from './catalogues/cost-panel.en';
import { exportDialogEn } from './catalogues/export-dialog.en';
import { dataConnectorEn } from './catalogues/data-connector.en';
import { extensionsFlavorsEn } from './catalogues/extensions-flavors.en';
import { extensionsPanelsEn } from './catalogues/extensions-panels.en';
import { ganttWorkCalendarEn } from './catalogues/gantt-work-calendar.en';
import { geometryExportDialogsEn } from './catalogues/geometry-export-dialogs.en';
import { filterGroupsEn } from './catalogues/filter-groups.en';
import { documentEn } from './catalogues/document.en';
import { documentMenuEn } from './catalogues/document-menu.en';
import { drawingUnderlayEn } from './catalogues/drawing-underlay.en';
import { hierarchyEn } from './catalogues/hierarchy.en';
import { idsPanelEn } from './catalogues/ids-panel.en';
import { validationEditorEn } from './catalogues/validation-editor.en';
import { validationPanelEn } from './catalogues/validation-panel.en';
import { flowPanelEn } from './catalogues/flow-panel.en';
import { keyboardShortcutsEn } from './catalogues/keyboard-shortcuts.en';
import { settingsEn } from './catalogues/settings.en';
import { layersPanelEn } from './catalogues/layers-panel.en';
import { landXmlEn } from './catalogues/landxml.en';
import { lensPanelEn } from './catalogues/lens-panel.en';
import { mainToolbarEn } from './catalogues/main-toolbar.en';
import { propertyEditorEn } from './catalogues/property-editor.en';
import { placementPanelEn } from './catalogues/placement-panel.en';
import { repositionPanelEn } from './catalogues/reposition-panel.en';
import { listsEn } from './catalogues/lists.en';
import { mcpEn } from './catalogues/mcp.en';
import { mcpPlaygroundEn } from './catalogues/mcp-playground.en';
import { measureEn } from './catalogues/measure.en';
import { mergeLayersBannerEn } from './catalogues/merge-layers-banner.en';
import { miscPanelsBEn } from './catalogues/misc-panels-b.en';
import { miscPanelsAEn } from './catalogues/misc-panels-a.en';
import { propertiesEn } from './catalogues/properties.en';
import { propertiesPanelEn } from './catalogues/properties-panel.en';
import { relationshipCardEn } from './catalogues/relationship-card.en';
import { ribbonToolbarEn } from './catalogues/ribbon-toolbar.en';
import { scheduleEn } from './catalogues/schedule.en';
import { sectionToolEn } from './catalogues/section-tool.en';
import { section2dEn } from './catalogues/section-2d.en';
import { sheetsPdfEn } from './catalogues/sheets-pdf.en';
import { searchModalEn } from './catalogues/search-modal.en';
import { searchFiltersEn } from './catalogues/search-filters.en';
import { visibilityReasonsEn } from './catalogues/visibility-reasons.en';
import { sharedCommandsEn } from './catalogues/shared-commands.en';
import { shellChromeEn } from './catalogues/shell-chrome.en';
import { sourcesEn } from './catalogues/sources.en';
import { toursEn } from './catalogues/tours.en';
import { viewerShellEn } from './catalogues/viewer-shell.en';
import { viewportLightingEn } from './catalogues/viewport-lighting.en';
import { spaceSketchEn } from './catalogues/space-sketch.en';
import { splitToolEn } from './catalogues/split-tool.en';
import { structuralPropertiesEn } from './catalogues/structural-properties.en';
import { webgpuTroubleshootingEn } from './catalogues/webgpu-troubleshooting.en';
import { scriptPanelEn } from './catalogues/script-panel.en';
import { zonesPanelEn } from './catalogues/zones-panel.en';

/** English is assembled from feature catalogues so no locale becomes a monolith. */
export const en = {
  ...analysisStaleEn,
  ...addElementEn,
  ...annotationsEn,
  ...anonymizedExportEn,
  ...exportDialogEn,
  ...bulkPropertyEditorEn,
  ...cesiumGeoEn,
  ...mergeLayersBannerEn,
  ...appearanceAssignmentListEn,
  ...appearanceAssignmentMembersEn,
  ...sectionToolEn,
  ...section2dEn,
  ...costPanelEn,
  ...ribbonToolbarEn,
  ...relationshipCardEn,
  ...mainToolbarEn,
  ...propertyEditorEn,
  ...sharedCommandsEn,
  ...commandPaletteEn,
  ...ganttWorkCalendarEn,
  ...filterGroupsEn,
  ...chartsEn,
  ...listsEn,
  ...clashGroupsEn,
  ...scheduleEn,
  ...mcpEn,
  ...mcpPlaygroundEn,
  ...sourcesEn,
  ...toursEn,
  ...viewerShellEn,
  ...shellChromeEn,
  ...measureEn,
  ...spaceSketchEn,
  ...splitToolEn,
  ...documentEn,
  ...documentMenuEn,
  ...drawingUnderlayEn,
  ...keyboardShortcutsEn,
  ...settingsEn,
  ...hierarchyEn,
  ...propertiesEn,
  ...propertiesPanelEn,
  ...landXmlEn,
  ...structuralPropertiesEn,
  ...appearancePanelEn,
  ...appearancePickersEn,
  ...appearanceWorkflowsEn,
  ...compareKeyPropertyEn,
  ...comparePanelEn,
  ...extensionsFlavorsEn,
  ...extensionsPanelsEn,
  ...idsPanelEn,
  ...validationEditorEn,
  ...validationPanelEn,
  ...flowPanelEn,
  ...chatEn,
  ...chatByokEn,
  ...clashPanelEn,
  ...clashToolsEn,
  ...bcfEn,
  ...layersPanelEn,
  ...lensPanelEn,
  ...searchModalEn,
  ...searchFiltersEn,
  ...visibilityReasonsEn,
  ...repositionPanelEn,
  ...placementPanelEn,
  ...webgpuTroubleshootingEn,
  ...scriptPanelEn,
  ...zonesPanelEn,
  ...dataConnectorEn,
  ...geometryExportDialogsEn,
  ...miscPanelsBEn,
  ...viewportLightingEn,
  ...miscPanelsAEn,
  ...sheetsPdfEn,
} as const;

export type TranslationKey = keyof typeof en;
