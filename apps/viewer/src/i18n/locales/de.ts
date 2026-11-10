/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../registry';
import { activityTrayDe } from './de/activity-tray';
import { aiReportsDe } from './de/ai-reports';
import { alignmentSectionDe } from './de/alignment-section';
import { analysisPanelDe } from './de/analysis-panel';
import { annotationsDe } from './de/annotations';
import { anonymizedExportDe } from './de/anonymized-export';
import { appearanceAssignmentListDe } from './de/appearance-assignment-list';
import { appearanceAssignmentMembersDe } from './de/appearance-assignment-members';
import { appearancePanelDe } from './de/appearance-panel';
import { appearancePickersDe } from './de/appearance-pickers';
import { appearanceWorkflowsDe } from './de/appearance-workflows';
import { assistantArtifactsDe } from './de/assistant-artifacts';
import { assistantPackAutomationDe } from './de/assistant-pack-automation';
import { assistantPackChecksDe } from './de/assistant-pack-checks';
import { assistantPackCoordinationDe } from './de/assistant-pack-coordination';
import { assistantPackMeasureDe } from './de/assistant-pack-measure';
import { assistantPackSiteDe } from './de/assistant-pack-site';
import { assistantPackTablesDe } from './de/assistant-pack-tables';
import { assistantReuseDe } from './de/assistant-reuse';
import { assistantSourcesDe } from './de/assistant-sources';
import { assistantUsageDe } from './de/assistant-usage';
import { assistantWorkbenchDe } from './de/assistant-workbench';
import { attributeEditorDe } from './de/attribute-editor';
import { automationEditorDe } from './de/automation-editor';
import { bcfDraftsDe } from './de/bcf-drafts';
import { bcfDe } from './de/bcf';
import { bulkPropertyEditorDe } from './de/bulk-property-editor';
import { capturedArtifactsDe } from './de/captured-artifacts';
import { cesiumGeoDe } from './de/cesium-geo';
import { changeSetsDe } from './de/change-sets';
import { changesPanelDe } from './de/changes-panel';
import { chartsDe } from './de/charts';
import { chatByokDe } from './de/chat-byok';
import { chatDe } from './de/chat';
import { checkAuthoringDe } from './de/check-authoring';
import { clashGroupApplyDe } from './de/clash-group-apply';
import { clashGroupsDe } from './de/clash-groups';
import { clashPanelDe } from './de/clash-panel';
import { clashQualityDe } from './de/clash-quality';
import { clashToolsDe } from './de/clash-tools';
import { commandPaletteDe } from './de/command-palette';
import { commandsDe } from './de/commands';
import { compareAnalysisDe } from './de/compare-analysis';
import { compareKeyPropertyDe } from './de/compare-key-property';
import { comparePanelDe } from './de/compare-panel';
import { copyArrayDe } from './de/copy-array';
import { costPanelDe } from './de/cost-panel';
import { costReviewDe } from './de/cost-review';
import { curtainGridDe } from './de/curtain-grid';
import { customGroupingDe } from './de/custom-grouping';
import { dataConnectorDe } from './de/data-connector';
import { deviationStatsDe } from './de/deviation-stats';
import { documentMenuDe } from './de/document-menu';
import { documentDe } from './de/document';
import { drawingUnderlayDe } from './de/drawing-underlay';
import { errorReportDe } from './de/error-report';
import { exportDialogDe } from './de/export-dialog';
import { extensionsFlavorsDe } from './de/extensions-flavors';
import { extensionsPanelsDe } from './de/extensions-panels';
import { extrusionInspectionDe } from './de/extrusion-inspection';
import { filterGroupsDe } from './de/filter-groups';
import { filterOperatorsDe } from './de/filter-operators';
import { flowAssistantDe } from './de/flow-assistant';
import { flowPanelDe } from './de/flow-panel';
import { flowReviewDe } from './de/flow-review';
import { flowStartupDe } from './de/flow-startup';
import { ganttWorkCalendarDe } from './de/gantt-work-calendar';
import { gaussianCaptureDe } from './de/gaussian-capture';
import { geometryExportDialogsDe } from './de/geometry-export-dialogs';
import { georeferencingDe } from './de/georeferencing';
import { groupReviewDe } from './de/group-review';
import { hierarchyDe } from './de/hierarchy';
import { hostedPlaceDe } from './de/hosted-place';
import { idsAgentDe } from './de/ids-agent';
import { idsPanelDe } from './de/ids-panel';
import { idsStudioDe } from './de/ids-studio';
import { ifcFederationAssumptionsDe } from './de/ifc-federation-assumptions';
import { influxDe } from './de/influx';
import { ionUploadDe } from './de/ion-upload';
import { keyboardShortcutsDe } from './de/keyboard-shortcuts';
import { landxmlGeorefAssumptionsDe } from './de/landxml-georef-assumptions';
import { landXmlTerrainExportDe } from './de/landxml-terrain-export';
import { landxmlDe } from './de/landxml';
import { layersPanelDe } from './de/layers-panel';
import { lensPanelDe } from './de/lens-panel';
import { listsDe } from './de/lists';
import { manualValidationDe } from './de/manual-validation';
import { mcpPlaygroundDe } from './de/mcp-playground';
import { mcpDe } from './de/mcp';
import { measureDe } from './de/measure';
import { mergeLayersBannerDe } from './de/merge-layers-banner';
import { miscPanelsADe } from './de/misc-panels-a';
import { miscPanelsBDe } from './de/misc-panels-b';
import { modelAuthoringDe } from './de/model-authoring';
import { modelChangesDe } from './de/model-changes';
import { modelInspectorDe } from './de/model-inspector';
import { modelWorkspaceDe } from './de/model-workspace';
import { modelingCommandDe } from './de/modeling-command';
import { moveRotateDe } from './de/move-rotate';
import { multiSplitDe } from './de/multi-split';
import { mutationPermissionDe } from './de/mutation-permission';
import { newIfcDe } from './de/new-ifc';
import { panelNoModelDe } from './de/panel-no-model';
import { placementPanelDe } from './de/placement-panel';
import { planHandlesDe } from './de/plan-handles';
import { profileSectionDe } from './de/profile-section';
import { propertiesPanelDe } from './de/properties-panel';
import { propertiesSelectionDe } from './de/properties-selection';
import { propertiesDe } from './de/properties';
import { propertyEditorDe } from './de/property-editor';
import { pushPullAlignDe } from './de/push-pull-align';
import { registryDe } from './de/registry';
import { relationshipCardDe } from './de/relationship-card';
import { remeshDe } from './de/remesh';
import { repositionPanelDe } from './de/reposition-panel';
import { resultViewDe } from './de/result-view';
import { retainedGeometryDe } from './de/retained-geometry';
import { reviewWorkspaceDe } from './de/review-workspace';
import { ribbonToolbarDe } from './de/ribbon-toolbar';
import { roomLayoutDe } from './de/room-layout';
import { roomReviewDe } from './de/room-review';
import { roomToolDe } from './de/room-tool';
import { scanToBimDe } from './de/scan-to-bim';
import { sceneActionsDe } from './de/scene-actions';
import { scheduleDe } from './de/schedule';
import { scriptPanelDe } from './de/script-panel';
import { searchFiltersDe } from './de/search-filters';
import { searchModalDe } from './de/search-modal';
import { section2dDe } from './de/section-2d';
import { sectionPlanesDe } from './de/section-planes';
import { sectionToolDe } from './de/section-tool';
import { semanticAssistDe } from './de/semantic-assist';
import { semanticIdentityDe } from './de/semantic-identity';
import { semanticResultsDe } from './de/semantic-results';
import { semanticDe } from './de/semantic';
import { settingsDe } from './de/settings';
import { sharedCommandsDe } from './de/shared-commands';
import { sheetsPdfDe } from './de/sheets-pdf';
import { shellChromeDe } from './de/shell-chrome';
import { sourcesDe } from './de/sources';
import { spaceEnvelopeDe } from './de/space-envelope';
import { splitToolDe } from './de/split-tool';
import { stairRailingDe } from './de/stair-railing';
import { storeyContextDe } from './de/storey-context';
import { storeyManagerDe } from './de/storey-manager';
import { structuralPropertiesDe } from './de/structural-properties';
import { structuralReviewDe } from './de/structural-review';
import { sweptDiskInspectionDe } from './de/swept-disk-inspection';
import { tableCorrectionsDe } from './de/table-corrections';
import { terrainImageryDe } from './de/terrain-imagery';
import { toursDe } from './de/tours';
import { trimExtendDe } from './de/trim-extend';
import { validationEditorDe } from './de/validation-editor';
import { validationPanelDe } from './de/validation-panel';
import { viewerShellDe } from './de/viewer-shell';
import { viewportLightingDe } from './de/viewport-lighting';
import { visibilityReasonsDe } from './de/visibility-reasons';
import { webgpuTroubleshootingDe } from './de/webgpu-troubleshooting';
import { workspaceMigrationDe } from './de/workspace-migration';
import { zoneEmissionDe } from './de/zone-emission';
import { zonesPanelDe } from './de/zones-panel';

export default {
  ...activityTrayDe,
  ...aiReportsDe,
  ...alignmentSectionDe,
  ...analysisPanelDe,
  ...annotationsDe,
  ...anonymizedExportDe,
  ...appearanceAssignmentListDe,
  ...appearanceAssignmentMembersDe,
  ...appearancePanelDe,
  ...appearancePickersDe,
  ...appearanceWorkflowsDe,
  ...assistantArtifactsDe,
  ...assistantPackAutomationDe,
  ...assistantPackChecksDe,
  ...assistantPackCoordinationDe,
  ...assistantPackMeasureDe,
  ...assistantPackSiteDe,
  ...assistantPackTablesDe,
  ...assistantReuseDe,
  ...assistantSourcesDe,
  ...assistantUsageDe,
  ...assistantWorkbenchDe,
  ...attributeEditorDe,
  ...automationEditorDe,
  ...bcfDraftsDe,
  ...bcfDe,
  ...bulkPropertyEditorDe,
  ...capturedArtifactsDe,
  ...cesiumGeoDe,
  ...changeSetsDe,
  ...changesPanelDe,
  ...chartsDe,
  ...chatByokDe,
  ...chatDe,
  ...checkAuthoringDe,
  ...clashGroupApplyDe,
  ...clashGroupsDe,
  ...clashPanelDe,
  ...clashQualityDe,
  ...clashToolsDe,
  ...commandPaletteDe,
  ...commandsDe,
  ...compareAnalysisDe,
  ...compareKeyPropertyDe,
  ...comparePanelDe,
  ...copyArrayDe,
  ...costPanelDe,
  ...costReviewDe,
  ...curtainGridDe,
  ...customGroupingDe,
  ...dataConnectorDe,
  ...deviationStatsDe,
  ...documentMenuDe,
  ...documentDe,
  ...drawingUnderlayDe,
  ...errorReportDe,
  ...exportDialogDe,
  ...extensionsFlavorsDe,
  ...extensionsPanelsDe,
  ...extrusionInspectionDe,
  ...filterGroupsDe,
  ...filterOperatorsDe,
  ...flowAssistantDe,
  ...flowPanelDe,
  ...flowReviewDe,
  ...flowStartupDe,
  ...ganttWorkCalendarDe,
  ...gaussianCaptureDe,
  ...geometryExportDialogsDe,
  ...georeferencingDe,
  ...groupReviewDe,
  ...hierarchyDe,
  ...hostedPlaceDe,
  ...idsAgentDe,
  ...idsPanelDe,
  ...idsStudioDe,
  ...ifcFederationAssumptionsDe,
  ...influxDe,
  ...ionUploadDe,
  ...keyboardShortcutsDe,
  ...landxmlGeorefAssumptionsDe,
  ...landXmlTerrainExportDe,
  ...landxmlDe,
  ...layersPanelDe,
  ...lensPanelDe,
  ...listsDe,
  ...manualValidationDe,
  ...mcpPlaygroundDe,
  ...mcpDe,
  ...measureDe,
  ...mergeLayersBannerDe,
  ...miscPanelsADe,
  ...miscPanelsBDe,
  ...modelAuthoringDe,
  ...modelChangesDe,
  ...modelInspectorDe,
  ...modelWorkspaceDe,
  ...modelingCommandDe,
  ...moveRotateDe,
  ...multiSplitDe,
  ...mutationPermissionDe,
  ...newIfcDe,
  ...panelNoModelDe,
  ...placementPanelDe,
  ...planHandlesDe,
  ...profileSectionDe,
  ...propertiesPanelDe,
  ...propertiesSelectionDe,
  ...propertiesDe,
  ...propertyEditorDe,
  ...pushPullAlignDe,
  ...registryDe,
  ...relationshipCardDe,
  ...remeshDe,
  ...repositionPanelDe,
  ...resultViewDe,
  ...retainedGeometryDe,
  ...reviewWorkspaceDe,
  ...ribbonToolbarDe,
  ...roomLayoutDe,
  ...roomReviewDe,
  ...roomToolDe,
  ...scanToBimDe,
  ...sceneActionsDe,
  ...scheduleDe,
  ...scriptPanelDe,
  ...searchFiltersDe,
  ...searchModalDe,
  ...section2dDe,
  ...sectionPlanesDe,
  ...sectionToolDe,
  ...semanticAssistDe,
  ...semanticIdentityDe,
  ...semanticResultsDe,
  ...semanticDe,
  ...settingsDe,
  ...sharedCommandsDe,
  ...sheetsPdfDe,
  ...shellChromeDe,
  ...sourcesDe,
  ...spaceEnvelopeDe,
  ...splitToolDe,
  ...stairRailingDe,
  ...storeyContextDe,
  ...storeyManagerDe,
  ...structuralPropertiesDe,
  ...structuralReviewDe,
  ...sweptDiskInspectionDe,
  ...tableCorrectionsDe,
  ...terrainImageryDe,
  ...toursDe,
  ...trimExtendDe,
  ...validationEditorDe,
  ...validationPanelDe,
  ...viewerShellDe,
  ...viewportLightingDe,
  ...visibilityReasonsDe,
  ...webgpuTroubleshootingDe,
  ...workspaceMigrationDe,
  ...zoneEmissionDe,
  ...zonesPanelDe,
} satisfies Catalogue;
