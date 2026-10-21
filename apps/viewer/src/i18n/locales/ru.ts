/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../registry';
import { activityTrayRu } from './ru/activity-tray';
import { aiReportsRu } from './ru/ai-reports';
import { alignmentSectionRu } from './ru/alignment-section';
import { analysisPanelRu } from './ru/analysis-panel';
import { annotationsRu } from './ru/annotations';
import { anonymizedExportRu } from './ru/anonymized-export';
import { appearanceAssignmentListRu } from './ru/appearance-assignment-list';
import { appearanceAssignmentMembersRu } from './ru/appearance-assignment-members';
import { appearancePanelRu } from './ru/appearance-panel';
import { appearancePickersRu } from './ru/appearance-pickers';
import { appearanceWorkflowsRu } from './ru/appearance-workflows';
import { assistantArtifactsRu } from './ru/assistant-artifacts';
import { assistantPackAutomationRu } from './ru/assistant-pack-automation';
import { assistantPackChecksRu } from './ru/assistant-pack-checks';
import { assistantPackCoordinationRu } from './ru/assistant-pack-coordination';
import { assistantPackMeasureRu } from './ru/assistant-pack-measure';
import { assistantPackSiteRu } from './ru/assistant-pack-site';
import { assistantPackTablesRu } from './ru/assistant-pack-tables';
import { assistantReuseRu } from './ru/assistant-reuse';
import { assistantSourcesRu } from './ru/assistant-sources';
import { assistantUsageRu } from './ru/assistant-usage';
import { assistantWorkbenchRu } from './ru/assistant-workbench';
import { attributeEditorRu } from './ru/attribute-editor';
import { automationEditorRu } from './ru/automation-editor';
import { bcfRu } from './ru/bcf';
import { bcfDraftsRu } from './ru/bcf-drafts';
import { bulkPropertyEditorRu } from './ru/bulk-property-editor';
import { capturedArtifactsRu } from './ru/captured-artifacts';
import { cesiumGeoRu } from './ru/cesium-geo';
import { changeSetsRu } from './ru/change-sets';
import { changesPanelRu } from './ru/changes-panel';
import { chartsRu } from './ru/charts';
import { chatRu } from './ru/chat';
import { chatByokRu } from './ru/chat-byok';
import { checkAuthoringRu } from './ru/check-authoring';
import { clashGroupApplyRu } from './ru/clash-group-apply';
import { clashGroupsRu } from './ru/clash-groups';
import { clashPanelRu } from './ru/clash-panel';
import { clashToolsRu } from './ru/clash-tools';
import { commandPaletteRu } from './ru/command-palette';
import { commandsRu } from './ru/commands';
import { compareAnalysisRu } from './ru/compare-analysis';
import { compareKeyPropertyRu } from './ru/compare-key-property';
import { comparePanelRu } from './ru/compare-panel';
import { copyArrayRu } from './ru/copy-array';
import { costPanelRu } from './ru/cost-panel';
import { costReviewRu } from './ru/cost-review';
import { curtainGridRu } from './ru/curtain-grid';
import { dataConnectorRu } from './ru/data-connector';
import { deviationStatsRu } from './ru/deviation-stats';
import { documentRu } from './ru/document';
import { documentMenuRu } from './ru/document-menu';
import { drawingUnderlayRu } from './ru/drawing-underlay';
import { errorReportRu } from './ru/error-report';
import { exportDialogRu } from './ru/export-dialog';
import { extensionsFlavorsRu } from './ru/extensions-flavors';
import { extensionsPanelsRu } from './ru/extensions-panels';
import { extrusionInspectionRu } from './ru/extrusion-inspection';
import { filterGroupsRu } from './ru/filter-groups';
import { filterOperatorsRu } from './ru/filter-operators';
import { flowAssistantRu } from './ru/flow-assistant';
import { flowPanelRu } from './ru/flow-panel';
import { flowReviewRu } from './ru/flow-review';
import { flowStartupRu } from './ru/flow-startup';
import { ganttWorkCalendarRu } from './ru/gantt-work-calendar';
import { geometryExportDialogsRu } from './ru/geometry-export-dialogs';
import { georeferencingRu } from './ru/georeferencing';
import { groupReviewRu } from './ru/group-review';
import { hierarchyRu } from './ru/hierarchy';
import { hostedPlaceRu } from './ru/hosted-place';
import { idsAgentRu } from './ru/ids-agent';
import { idsPanelRu } from './ru/ids-panel';
import { idsStudioRu } from './ru/ids-studio';
import { ionUploadRu } from './ru/ion-upload';
import { keyboardShortcutsRu } from './ru/keyboard-shortcuts';
import { landxmlRu } from './ru/landxml';
import { landxmlGeorefAssumptionsRu } from './ru/landxml-georef-assumptions';
import { landxmlTerrainExportRu } from './ru/landxml-terrain-export';
import { layersPanelRu } from './ru/layers-panel';
import { lensPanelRu } from './ru/lens-panel';
import { listsRu } from './ru/lists';
import { manualValidationRu } from './ru/manual-validation';
import { mcpRu } from './ru/mcp';
import { mcpPlaygroundRu } from './ru/mcp-playground';
import { measureRu } from './ru/measure';
import { mergeLayersBannerRu } from './ru/merge-layers-banner';
import { miscPanelsARu } from './ru/misc-panels-a';
import { miscPanelsBRu } from './ru/misc-panels-b';
import { modelAuthoringRu } from './ru/model-authoring';
import { modelChangesRu } from './ru/model-changes';
import { modelInspectorRu } from './ru/model-inspector';
import { modelWorkspaceRu } from './ru/model-workspace';
import { modelingCommandRu } from './ru/modeling-command';
import { moveRotateRu } from './ru/move-rotate';
import { multiSplitRu } from './ru/multi-split';
import { mutationPermissionRu } from './ru/mutation-permission';
import { newIfcRu } from './ru/new-ifc';
import { panelNoModelRu } from './ru/panel-no-model';
import { placementPanelRu } from './ru/placement-panel';
import { planHandlesRu } from './ru/plan-handles';
import { profileSectionRu } from './ru/profile-section';
import { propertiesRu } from './ru/properties';
import { propertiesPanelRu } from './ru/properties-panel';
import { propertiesSelectionRu } from './ru/properties-selection';
import { propertyEditorRu } from './ru/property-editor';
import { pushPullAlignRu } from './ru/push-pull-align';
import { relationshipCardRu } from './ru/relationship-card';
import { remeshRu } from './ru/remesh';
import { repositionPanelRu } from './ru/reposition-panel';
import { resultViewRu } from './ru/result-view';
import { reviewWorkspaceRu } from './ru/review-workspace';
import { ribbonToolbarRu } from './ru/ribbon-toolbar';
import { roomLayoutRu } from './ru/room-layout';
import { roomReviewRu } from './ru/room-review';
import { roomToolRu } from './ru/room-tool';
import { scanToBimRu } from './ru/scan-to-bim';
import { sceneActionsRu } from './ru/scene-actions';
import { scheduleRu } from './ru/schedule';
import { scriptPanelRu } from './ru/script-panel';
import { searchFiltersRu } from './ru/search-filters';
import { searchModalRu } from './ru/search-modal';
import { section2dRu } from './ru/section-2d';
import { sectionPlanesRu } from './ru/section-planes';
import { sectionToolRu } from './ru/section-tool';
import { semanticRu } from './ru/semantic';
import { semanticAssistRu } from './ru/semantic-assist';
import { semanticIdentityRu } from './ru/semantic-identity';
import { semanticResultsRu } from './ru/semantic-results';
import { settingsRu } from './ru/settings';
import { sharedCommandsRu } from './ru/shared-commands';
import { sheetsPdfRu } from './ru/sheets-pdf';
import { shellChromeRu } from './ru/shell-chrome';
import { sourcesRu } from './ru/sources';
import { spaceEnvelopeRu } from './ru/space-envelope';
import { splitToolRu } from './ru/split-tool';
import { stairRailingRu } from './ru/stair-railing';
import { storeyContextRu } from './ru/storey-context';
import { structuralPropertiesRu } from './ru/structural-properties';
import { structuralReviewRu } from './ru/structural-review';
import { sweptDiskInspectionRu } from './ru/swept-disk-inspection';
import { tableCorrectionsRu } from './ru/table-corrections';
import { terrainImageryRu } from './ru/terrain-imagery';
import { toursRu } from './ru/tours';
import { trimExtendRu } from './ru/trim-extend';
import { validationEditorRu } from './ru/validation-editor';
import { validationPanelRu } from './ru/validation-panel';
import { viewerShellRu } from './ru/viewer-shell';
import { viewportLightingRu } from './ru/viewport-lighting';
import { visibilityReasonsRu } from './ru/visibility-reasons';
import { webgpuTroubleshootingRu } from './ru/webgpu-troubleshooting';
import { workspaceMigrationRu } from './ru/workspace-migration';
import { zoneEmissionRu } from './ru/zone-emission';
import { zonesPanelRu } from './ru/zones-panel';

export default {
  ...activityTrayRu,
  ...aiReportsRu,
  ...alignmentSectionRu,
  ...analysisPanelRu,
  ...annotationsRu,
  ...anonymizedExportRu,
  ...appearanceAssignmentListRu,
  ...appearanceAssignmentMembersRu,
  ...appearancePanelRu,
  ...appearancePickersRu,
  ...appearanceWorkflowsRu,
  ...assistantArtifactsRu,
  ...assistantPackAutomationRu,
  ...assistantPackChecksRu,
  ...assistantPackCoordinationRu,
  ...assistantPackMeasureRu,
  ...assistantPackSiteRu,
  ...assistantPackTablesRu,
  ...assistantReuseRu,
  ...assistantSourcesRu,
  ...assistantUsageRu,
  ...assistantWorkbenchRu,
  ...attributeEditorRu,
  ...automationEditorRu,
  ...bcfRu,
  ...bcfDraftsRu,
  ...bulkPropertyEditorRu,
  ...capturedArtifactsRu,
  ...cesiumGeoRu,
  ...changeSetsRu,
  ...changesPanelRu,
  ...chartsRu,
  ...chatRu,
  ...chatByokRu,
  ...checkAuthoringRu,
  ...clashGroupApplyRu,
  ...clashGroupsRu,
  ...clashPanelRu,
  ...clashToolsRu,
  ...commandPaletteRu,
  ...commandsRu,
  ...compareAnalysisRu,
  ...compareKeyPropertyRu,
  ...comparePanelRu,
  ...copyArrayRu,
  ...costPanelRu,
  ...costReviewRu,
  ...curtainGridRu,
  ...dataConnectorRu,
  ...deviationStatsRu,
  ...documentRu,
  ...documentMenuRu,
  ...drawingUnderlayRu,
  ...errorReportRu,
  ...exportDialogRu,
  ...extensionsFlavorsRu,
  ...extensionsPanelsRu,
  ...extrusionInspectionRu,
  ...filterGroupsRu,
  ...filterOperatorsRu,
  ...flowAssistantRu,
  ...flowPanelRu,
  ...flowReviewRu,
  ...flowStartupRu,
  ...ganttWorkCalendarRu,
  ...geometryExportDialogsRu,
  ...georeferencingRu,
  ...groupReviewRu,
  ...hierarchyRu,
  ...hostedPlaceRu,
  ...idsAgentRu,
  ...idsPanelRu,
  ...idsStudioRu,
  ...ionUploadRu,
  ...keyboardShortcutsRu,
  ...landxmlRu,
  ...landxmlGeorefAssumptionsRu,
  ...landxmlTerrainExportRu,
  ...layersPanelRu,
  ...lensPanelRu,
  ...listsRu,
  ...manualValidationRu,
  ...mcpRu,
  ...mcpPlaygroundRu,
  ...measureRu,
  ...mergeLayersBannerRu,
  ...miscPanelsARu,
  ...miscPanelsBRu,
  ...modelAuthoringRu,
  ...modelChangesRu,
  ...modelInspectorRu,
  ...modelWorkspaceRu,
  ...modelingCommandRu,
  ...moveRotateRu,
  ...multiSplitRu,
  ...mutationPermissionRu,
  ...newIfcRu,
  ...panelNoModelRu,
  ...placementPanelRu,
  ...planHandlesRu,
  ...profileSectionRu,
  ...propertiesRu,
  ...propertiesPanelRu,
  ...propertiesSelectionRu,
  ...propertyEditorRu,
  ...pushPullAlignRu,
  ...relationshipCardRu,
  ...remeshRu,
  ...repositionPanelRu,
  ...resultViewRu,
  ...reviewWorkspaceRu,
  ...ribbonToolbarRu,
  ...roomLayoutRu,
  ...roomReviewRu,
  ...roomToolRu,
  ...scanToBimRu,
  ...sceneActionsRu,
  ...scheduleRu,
  ...scriptPanelRu,
  ...searchFiltersRu,
  ...searchModalRu,
  ...section2dRu,
  ...sectionPlanesRu,
  ...sectionToolRu,
  ...semanticRu,
  ...semanticAssistRu,
  ...semanticIdentityRu,
  ...semanticResultsRu,
  ...settingsRu,
  ...sharedCommandsRu,
  ...sheetsPdfRu,
  ...shellChromeRu,
  ...sourcesRu,
  ...spaceEnvelopeRu,
  ...splitToolRu,
  ...stairRailingRu,
  ...storeyContextRu,
  ...structuralPropertiesRu,
  ...structuralReviewRu,
  ...sweptDiskInspectionRu,
  ...tableCorrectionsRu,
  ...terrainImageryRu,
  ...toursRu,
  ...trimExtendRu,
  ...validationEditorRu,
  ...validationPanelRu,
  ...viewerShellRu,
  ...viewportLightingRu,
  ...visibilityReasonsRu,
  ...webgpuTroubleshootingRu,
  ...workspaceMigrationRu,
  ...zoneEmissionRu,
  ...zonesPanelRu,
} satisfies Catalogue;
