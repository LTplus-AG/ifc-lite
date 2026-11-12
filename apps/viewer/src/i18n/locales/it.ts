/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../registry';
import { registryIt } from './it/registry';
import { storeyManagerIt } from './it/storey-manager';
import { activityTrayIt } from './it/activity-tray';
import { aiReportsIt } from './it/ai-reports';
import { alignmentSectionIt } from './it/alignment-section';
import { analysisPanelIt } from './it/analysis-panel';
import { annotationsIt } from './it/annotations';
import { anonymizedExportIt } from './it/anonymized-export';
import { appearanceAssignmentListIt } from './it/appearance-assignment-list';
import { appearanceAssignmentMembersIt } from './it/appearance-assignment-members';
import { appearancePanelIt } from './it/appearance-panel';
import { appearancePickersIt } from './it/appearance-pickers';
import { appearanceWorkflowsIt } from './it/appearance-workflows';
import { assistantArtifactsIt } from './it/assistant-artifacts';
import { assistantPackAutomationIt } from './it/assistant-pack-automation';
import { assistantPackChecksIt } from './it/assistant-pack-checks';
import { assistantPackCoordinationIt } from './it/assistant-pack-coordination';
import { assistantPackMeasureIt } from './it/assistant-pack-measure';
import { assistantPackSiteIt } from './it/assistant-pack-site';
import { assistantPackTablesIt } from './it/assistant-pack-tables';
import { assistantReuseIt } from './it/assistant-reuse';
import { assistantSourcesIt } from './it/assistant-sources';
import { assistantUsageIt } from './it/assistant-usage';
import { assistantWorkbenchIt } from './it/assistant-workbench';
import { attributeEditorIt } from './it/attribute-editor';
import { automationEditorIt } from './it/automation-editor';
import { bcfDraftsIt } from './it/bcf-drafts';
import { bcfIt } from './it/bcf';
import { bulkPropertyEditorIt } from './it/bulk-property-editor';
import { capturedArtifactsIt } from './it/captured-artifacts';
import { cesiumGeoIt } from './it/cesium-geo';
import { changeSetsIt } from './it/change-sets';
import { changesPanelIt } from './it/changes-panel';
import { chartsIt } from './it/charts';
import { chatByokIt } from './it/chat-byok';
import { chatIt } from './it/chat';
import { checkAuthoringIt } from './it/check-authoring';
import { clashGroupApplyIt } from './it/clash-group-apply';
import { clashGroupsIt } from './it/clash-groups';
import { clashPanelIt } from './it/clash-panel';
import { clashQualityIt } from './it/clash-quality';
import { clashToolsIt } from './it/clash-tools';
import { commandPaletteIt } from './it/command-palette';
import { commandsIt } from './it/commands';
import { compareAnalysisIt } from './it/compare-analysis';
import { compareKeyPropertyIt } from './it/compare-key-property';
import { comparePanelIt } from './it/compare-panel';
import { copyArrayIt } from './it/copy-array';
import { costPanelIt } from './it/cost-panel';
import { costReviewIt } from './it/cost-review';
import { curtainGridIt } from './it/curtain-grid';
import { customGroupingIt } from './it/custom-grouping';
import { dataConnectorIt } from './it/data-connector';
import { deviationStatsIt } from './it/deviation-stats';
import { documentMenuIt } from './it/document-menu';
import { documentIt } from './it/document';
import { drawingUnderlayIt } from './it/drawing-underlay';
import { errorReportIt } from './it/error-report';
import { exportDialogIt } from './it/export-dialog';
import { extensionsFlavorsIt } from './it/extensions-flavors';
import { extensionsPanelsIt } from './it/extensions-panels';
import { extrusionInspectionIt } from './it/extrusion-inspection';
import { filterGroupsIt } from './it/filter-groups';
import { filterOperatorsIt } from './it/filter-operators';
import { flowAssistantIt } from './it/flow-assistant';
import { flowPanelIt } from './it/flow-panel';
import { flowReviewIt } from './it/flow-review';
import { flowStartupIt } from './it/flow-startup';
import { ganttWorkCalendarIt } from './it/gantt-work-calendar';
import { gaussianCaptureIt } from './it/gaussian-capture';
import { geometryExportDialogsIt } from './it/geometry-export-dialogs';
import { georeferencingIt } from './it/georeferencing';
import { groupReviewIt } from './it/group-review';
import { hierarchyIt } from './it/hierarchy';
import { hostedPlaceIt } from './it/hosted-place';
import { idsAgentIt } from './it/ids-agent';
import { idsPanelIt } from './it/ids-panel';
import { idsStudioIt } from './it/ids-studio';
import { ifcFederationAssumptionsIt } from './it/ifc-federation-assumptions';
import { influxIt } from './it/influx';
import { ionUploadIt } from './it/ion-upload';
import { keyboardShortcutsIt } from './it/keyboard-shortcuts';
import { landXmlGeorefAssumptionsIt } from './it/landxml-georef-assumptions';
import { landXmlTerrainExportIt } from './it/landxml-terrain-export';
import { rhinoExportIt } from './it/rhino-export';
import { landXmlIt } from './it/landxml';
import { layersPanelIt } from './it/layers-panel';
import { lensPanelIt } from './it/lens-panel';
import { listsIt } from './it/lists';
import { manualValidationIt } from './it/manual-validation';
import { mcpPlaygroundIt } from './it/mcp-playground';
import { mcpIt } from './it/mcp';
import { measureIt } from './it/measure';
import { mergeLayersBannerIt } from './it/merge-layers-banner';
import { miscPanelsAIt } from './it/misc-panels-a';
import { miscPanelsBIt } from './it/misc-panels-b';
import { modelAuthoringIt } from './it/model-authoring';
import { modelChangesIt } from './it/model-changes';
import { modelInspectorIt } from './it/model-inspector';
import { modelWorkspaceIt } from './it/model-workspace';
import { modelingCommandIt } from './it/modeling-command';
import { moveRotateIt } from './it/move-rotate';
import { multiSplitIt } from './it/multi-split';
import { mutationPermissionIt } from './it/mutation-permission';
import { newIfcIt } from './it/new-ifc';
import { panelNoModelIt } from './it/panel-no-model';
import { placementPanelIt } from './it/placement-panel';
import { planHandlesIt } from './it/plan-handles';
import { profileSectionIt } from './it/profile-section';
import { propertiesPanelIt } from './it/properties-panel';
import { propertiesSelectionIt } from './it/properties-selection';
import { propertiesIt } from './it/properties';
import { propertyEditorIt } from './it/property-editor';
import { pushPullAlignIt } from './it/push-pull-align';
import { relationshipCardIt } from './it/relationship-card';
import { remeshIt } from './it/remesh';
import { repositionPanelIt } from './it/reposition-panel';
import { resultViewIt } from './it/result-view';
import { retainedGeometryIt } from './it/retained-geometry';
import { reviewWorkspaceIt } from './it/review-workspace';
import { ribbonToolbarIt } from './it/ribbon-toolbar';
import { roomLayoutIt } from './it/room-layout';
import { roomReviewIt } from './it/room-review';
import { roomToolIt } from './it/room-tool';
import { scanToBimIt } from './it/scan-to-bim';
import { sceneActionsIt } from './it/scene-actions';
import { scheduleIt } from './it/schedule';
import { scriptPanelIt } from './it/script-panel';
import { searchFiltersIt } from './it/search-filters';
import { searchModalIt } from './it/search-modal';
import { section2dIt } from './it/section-2d';
import { sectionPlanesIt } from './it/section-planes';
import { sectionToolIt } from './it/section-tool';
import { semanticAssistIt } from './it/semantic-assist';
import { semanticIdentityIt } from './it/semantic-identity';
import { semanticResultsIt } from './it/semantic-results';
import { semanticIt } from './it/semantic';
import { settingsIt } from './it/settings';
import { sharedCommandsIt } from './it/shared-commands';
import { sheetsPdfIt } from './it/sheets-pdf';
import { shellChromeIt } from './it/shell-chrome';
import { sourcesIt } from './it/sources';
import { spaceEnvelopeIt } from './it/space-envelope';
import { splitToolIt } from './it/split-tool';
import { stairRailingIt } from './it/stair-railing';
import { storeyContextIt } from './it/storey-context';
import { structuralGlyphsIt } from './it/structural-glyphs';
import { structuralPropertiesIt } from './it/structural-properties';
import { structuralReviewIt } from './it/structural-review';
import { sweptDiskInspectionIt } from './it/swept-disk-inspection';
import { tableCorrectionsIt } from './it/table-corrections';
import { terrainImageryIt } from './it/terrain-imagery';
import { toursIt } from './it/tours';
import { trimExtendIt } from './it/trim-extend';
import { validationEditorIt } from './it/validation-editor';
import { validationPanelIt } from './it/validation-panel';
import { viewerShellIt } from './it/viewer-shell';
import { viewportLightingIt } from './it/viewport-lighting';
import { visibilityReasonsIt } from './it/visibility-reasons';
import { webgpuTroubleshootingIt } from './it/webgpu-troubleshooting';
import { workspaceMigrationIt } from './it/workspace-migration';
import { zoneEmissionIt } from './it/zone-emission';
import { zonesPanelIt } from './it/zones-panel';

export default {
  ...activityTrayIt,
  ...aiReportsIt,
  ...alignmentSectionIt,
  ...analysisPanelIt,
  ...annotationsIt,
  ...anonymizedExportIt,
  ...appearanceAssignmentListIt,
  ...appearanceAssignmentMembersIt,
  ...appearancePanelIt,
  ...appearancePickersIt,
  ...appearanceWorkflowsIt,
  ...assistantArtifactsIt,
  ...assistantPackAutomationIt,
  ...assistantPackChecksIt,
  ...assistantPackCoordinationIt,
  ...assistantPackMeasureIt,
  ...assistantPackSiteIt,
  ...assistantPackTablesIt,
  ...assistantReuseIt,
  ...assistantSourcesIt,
  ...assistantUsageIt,
  ...assistantWorkbenchIt,
  ...attributeEditorIt,
  ...automationEditorIt,
  ...bcfDraftsIt,
  ...bcfIt,
  ...bulkPropertyEditorIt,
  ...capturedArtifactsIt,
  ...cesiumGeoIt,
  ...changeSetsIt,
  ...changesPanelIt,
  ...chartsIt,
  ...chatByokIt,
  ...chatIt,
  ...checkAuthoringIt,
  ...clashGroupApplyIt,
  ...clashGroupsIt,
  ...clashPanelIt,
  ...clashQualityIt,
  ...clashToolsIt,
  ...commandPaletteIt,
  ...commandsIt,
  ...compareAnalysisIt,
  ...compareKeyPropertyIt,
  ...comparePanelIt,
  ...copyArrayIt,
  ...costPanelIt,
  ...costReviewIt,
  ...curtainGridIt,
  ...customGroupingIt,
  ...dataConnectorIt,
  ...deviationStatsIt,
  ...documentMenuIt,
  ...documentIt,
  ...drawingUnderlayIt,
  ...errorReportIt,
  ...exportDialogIt,
  ...extensionsFlavorsIt,
  ...extensionsPanelsIt,
  ...extrusionInspectionIt,
  ...filterGroupsIt,
  ...filterOperatorsIt,
  ...flowAssistantIt,
  ...flowPanelIt,
  ...flowReviewIt,
  ...flowStartupIt,
  ...ganttWorkCalendarIt,
  ...gaussianCaptureIt,
  ...geometryExportDialogsIt,
  ...georeferencingIt,
  ...groupReviewIt,
  ...hierarchyIt,
  ...hostedPlaceIt,
  ...idsAgentIt,
  ...idsPanelIt,
  ...idsStudioIt,
  ...ifcFederationAssumptionsIt,
  ...influxIt,
  ...ionUploadIt,
  ...keyboardShortcutsIt,
  ...landXmlGeorefAssumptionsIt,
  ...landXmlTerrainExportIt,
  ...rhinoExportIt,
  ...landXmlIt,
  ...layersPanelIt,
  ...lensPanelIt,
  ...listsIt,
  ...manualValidationIt,
  ...mcpPlaygroundIt,
  ...mcpIt,
  ...measureIt,
  ...mergeLayersBannerIt,
  ...miscPanelsAIt,
  ...miscPanelsBIt,
  ...modelAuthoringIt,
  ...modelChangesIt,
  ...modelInspectorIt,
  ...modelWorkspaceIt,
  ...modelingCommandIt,
  ...moveRotateIt,
  ...multiSplitIt,
  ...mutationPermissionIt,
  ...newIfcIt,
  ...panelNoModelIt,
  ...placementPanelIt,
  ...planHandlesIt,
  ...profileSectionIt,
  ...propertiesPanelIt,
  ...propertiesSelectionIt,
  ...propertiesIt,
  ...propertyEditorIt,
  ...pushPullAlignIt,
  ...relationshipCardIt,
  ...remeshIt,
  ...repositionPanelIt,
  ...resultViewIt,
  ...retainedGeometryIt,
  ...reviewWorkspaceIt,
  ...ribbonToolbarIt,
  ...roomLayoutIt,
  ...roomReviewIt,
  ...roomToolIt,
  ...scanToBimIt,
  ...sceneActionsIt,
  ...scheduleIt,
  ...scriptPanelIt,
  ...searchFiltersIt,
  ...searchModalIt,
  ...section2dIt,
  ...sectionPlanesIt,
  ...sectionToolIt,
  ...semanticAssistIt,
  ...semanticIdentityIt,
  ...semanticResultsIt,
  ...semanticIt,
  ...settingsIt,
  ...sharedCommandsIt,
  ...sheetsPdfIt,
  ...shellChromeIt,
  ...sourcesIt,
  ...spaceEnvelopeIt,
  ...splitToolIt,
  ...stairRailingIt,
  ...storeyContextIt,
  ...structuralGlyphsIt,
  ...structuralPropertiesIt,
  ...structuralReviewIt,
  ...sweptDiskInspectionIt,
  ...tableCorrectionsIt,
  ...terrainImageryIt,
  ...toursIt,
  ...trimExtendIt,
  ...validationEditorIt,
  ...validationPanelIt,
  ...viewerShellIt,
  ...viewportLightingIt,
  ...visibilityReasonsIt,
  ...webgpuTroubleshootingIt,
  ...workspaceMigrationIt,
  ...zoneEmissionIt,
  ...zonesPanelIt,
  ...registryIt,
  ...storeyManagerIt,
} satisfies Catalogue;
