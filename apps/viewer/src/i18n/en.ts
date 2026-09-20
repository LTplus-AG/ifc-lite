/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appearanceAssignmentListEn } from './catalogues/appearance-assignment-list.en';
import { appearanceAssignmentMembersEn } from './catalogues/appearance-assignment-members.en';
import { addElementEn } from './catalogues/add-element.en';
import { annotationsEn } from './catalogues/annotations.en';
import { anonymizedExportEn } from './catalogues/anonymized-export.en';
import { chartsEn } from './catalogues/charts.en';
import { clashPanelEn } from './catalogues/clash-panel.en';
import { appearancePanelEn } from './catalogues/appearance-panel.en';
import { appearancePickersEn } from './catalogues/appearance-pickers.en';
import { appearanceWorkflowsEn } from './catalogues/appearance-workflows.en';
import { bcfEn } from './catalogues/bcf.en';
import { clashGroupsEn } from './catalogues/clash-groups.en';
import { bulkPropertyEditorEn } from './catalogues/bulk-property-editor.en';
import { chatEn } from './catalogues/chat.en';
import { chatByokEn } from './catalogues/chat-byok.en';
import { commandPaletteEn } from './catalogues/command-palette.en';
import { compareKeyPropertyEn } from './catalogues/compare-key-property.en';
import { costPanelEn } from './catalogues/cost-panel.en';
import { extensionsFlavorsEn } from './catalogues/extensions-flavors.en';
import { extensionsPanelsEn } from './catalogues/extensions-panels.en';
import { ganttWorkCalendarEn } from './catalogues/gantt-work-calendar.en';
import { filterGroupsEn } from './catalogues/filter-groups.en';
import { documentEn } from './catalogues/document.en';
import { documentMenuEn } from './catalogues/document-menu.en';
import { hierarchyEn } from './catalogues/hierarchy.en';
import { idsPanelEn } from './catalogues/ids-panel.en';
import { layersPanelEn } from './catalogues/layers-panel.en';
import { mainToolbarEn } from './catalogues/main-toolbar.en';
import { propertyEditorEn } from './catalogues/property-editor.en';
import { repositionPanelEn } from './catalogues/reposition-panel.en';
import { listsEn } from './catalogues/lists.en';
import { mcpEn } from './catalogues/mcp.en';
import { mcpPlaygroundEn } from './catalogues/mcp-playground.en';
import { measureEn } from './catalogues/measure.en';
import { mergeLayersBannerEn } from './catalogues/merge-layers-banner.en';
import { propertiesEn } from './catalogues/properties.en';
import { relationshipCardEn } from './catalogues/relationship-card.en';
import { ribbonToolbarEn } from './catalogues/ribbon-toolbar.en';
import { scheduleEn } from './catalogues/schedule.en';
import { sectionToolEn } from './catalogues/section-tool.en';
import { section2dEn } from './catalogues/section-2d.en';
import { sharedCommandsEn } from './catalogues/shared-commands.en';
import { sourcesEn } from './catalogues/sources.en';
import { toursEn } from './catalogues/tours.en';
import { viewerShellEn } from './catalogues/viewer-shell.en';
import { spaceSketchEn } from './catalogues/space-sketch.en';
import { splitToolEn } from './catalogues/split-tool.en';
import { structuralPropertiesEn } from './catalogues/structural-properties.en';

/** English is assembled from feature catalogues so no locale becomes a monolith. */
export const en = {
  ...addElementEn,
  ...annotationsEn,
  ...anonymizedExportEn,
  ...bulkPropertyEditorEn,
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
  ...measureEn,
  ...spaceSketchEn,
  ...splitToolEn,
  ...documentEn,
  ...documentMenuEn,
  ...hierarchyEn,
  ...propertiesEn,
  ...structuralPropertiesEn,
  ...appearancePanelEn,
  ...appearancePickersEn,
  ...appearanceWorkflowsEn,
  ...compareKeyPropertyEn,
  ...extensionsFlavorsEn,
  ...extensionsPanelsEn,
  ...idsPanelEn,
  ...chatEn,
  ...chatByokEn,
  ...clashPanelEn,
  ...bcfEn,
  ...layersPanelEn,
  ...repositionPanelEn,
} as const;

export type TranslationKey = keyof typeof en;
