/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../registry';
import { registryFr } from './fr/registry';
import { storeyManagerFr } from './fr/storey-manager';
import { activityTrayFr } from './fr/activity-tray';
import { aiReportsFr } from './fr/ai-reports';
import { alignmentSectionFr } from './fr/alignment-section';
import { analysisPanelFr } from './fr/analysis-panel';
import { annotationsFr } from './fr/annotations';
import { anonymizedExportFr } from './fr/anonymized-export';
import { appearanceAssignmentListFr } from './fr/appearance-assignment-list';
import { appearanceAssignmentMembersFr } from './fr/appearance-assignment-members';
import { appearancePanelFr } from './fr/appearance-panel';
import { appearancePickersFr } from './fr/appearance-pickers';
import { appearanceWorkflowsFr } from './fr/appearance-workflows';
import { assistantArtifactsFr } from './fr/assistant-artifacts';
import { assistantPackAutomationFr } from './fr/assistant-pack-automation';
import { assistantPackChecksFr } from './fr/assistant-pack-checks';
import { assistantPackCoordinationFr } from './fr/assistant-pack-coordination';
import { assistantPackMeasureFr } from './fr/assistant-pack-measure';
import { assistantPackSiteFr } from './fr/assistant-pack-site';
import { assistantPackTablesFr } from './fr/assistant-pack-tables';
import { assistantReuseFr } from './fr/assistant-reuse';
import { assistantSourcesFr } from './fr/assistant-sources';
import { assistantUsageFr } from './fr/assistant-usage';
import { assistantWorkbenchFr } from './fr/assistant-workbench';
import { attributeEditorFr } from './fr/attribute-editor';
import { automationEditorFr } from './fr/automation-editor';
import { bcfDraftsFr } from './fr/bcf-drafts';
import { bcfFr } from './fr/bcf';
import { bulkPropertyEditorFr } from './fr/bulk-property-editor';
import { capturedArtifactsFr } from './fr/captured-artifacts';
import { cesiumGeoFr } from './fr/cesium-geo';
import { changeSetsFr } from './fr/change-sets';
import { changesPanelFr } from './fr/changes-panel';
import { chartsFr } from './fr/charts';
import { chatByokFr } from './fr/chat-byok';
import { chatFr } from './fr/chat';
import { checkAuthoringFr } from './fr/check-authoring';
import { clashGroupApplyFr } from './fr/clash-group-apply';
import { clashGroupsFr } from './fr/clash-groups';
import { clashPanelFr } from './fr/clash-panel';
import { clashQualityFr } from './fr/clash-quality';
import { clashToolsFr } from './fr/clash-tools';
import { commandPaletteFr } from './fr/command-palette';
import { commandsFr } from './fr/commands';
import { compareAnalysisFr } from './fr/compare-analysis';
import { compareKeyPropertyFr } from './fr/compare-key-property';
import { comparePanelFr } from './fr/compare-panel';
import { copyArrayFr } from './fr/copy-array';
import { costPanelFr } from './fr/cost-panel';
import { costReviewFr } from './fr/cost-review';
import { curtainGridFr } from './fr/curtain-grid';
import { customGroupingFr } from './fr/custom-grouping';
import { dataConnectorFr } from './fr/data-connector';
import { deviationStatsFr } from './fr/deviation-stats';
import { documentMenuFr } from './fr/document-menu';
import { documentFr } from './fr/document';
import { drawingUnderlayFr } from './fr/drawing-underlay';
import { errorReportFr } from './fr/error-report';
import { exportDialogFr } from './fr/export-dialog';
import { extensionsFlavorsFr } from './fr/extensions-flavors';
import { extensionsPanelsFr } from './fr/extensions-panels';
import { extrusionInspectionFr } from './fr/extrusion-inspection';
import { filterGroupsFr } from './fr/filter-groups';
import { filterOperatorsFr } from './fr/filter-operators';
import { flowAssistantFr } from './fr/flow-assistant';
import { flowPanelFr } from './fr/flow-panel';
import { flowReviewFr } from './fr/flow-review';
import { flowStartupFr } from './fr/flow-startup';
import { ganttWorkCalendarFr } from './fr/gantt-work-calendar';
import { gaussianCaptureFr } from './fr/gaussian-capture';
import { geometryExportDialogsFr } from './fr/geometry-export-dialogs';
import { georeferencingFr } from './fr/georeferencing';
import { groupReviewFr } from './fr/group-review';
import { hierarchyFr } from './fr/hierarchy';
import { hostedPlaceFr } from './fr/hosted-place';
import { idsAgentFr } from './fr/ids-agent';
import { idsPanelFr } from './fr/ids-panel';
import { idsStudioFr } from './fr/ids-studio';
import { ifcFederationAssumptionsFr } from './fr/ifc-federation-assumptions';
import { influxFr } from './fr/influx';
import { ionUploadFr } from './fr/ion-upload';
import { keyboardShortcutsFr } from './fr/keyboard-shortcuts';
import { landXmlGeorefAssumptionsFr } from './fr/landxml-georef-assumptions';
import { landXmlTerrainExportFr } from './fr/landxml-terrain-export';
import { landXmlFr } from './fr/landxml';
import { layersPanelFr } from './fr/layers-panel';
import { lensPanelFr } from './fr/lens-panel';
import { listsFr } from './fr/lists';
import { manualValidationFr } from './fr/manual-validation';
import { mcpPlaygroundFr } from './fr/mcp-playground';
import { mcpFr } from './fr/mcp';
import { measureFr } from './fr/measure';
import { mergeLayersBannerFr } from './fr/merge-layers-banner';
import { miscPanelsAFr } from './fr/misc-panels-a';
import { miscPanelsBFr } from './fr/misc-panels-b';
import { modelAuthoringFr } from './fr/model-authoring';
import { modelChangesFr } from './fr/model-changes';
import { modelInspectorFr } from './fr/model-inspector';
import { modelWorkspaceFr } from './fr/model-workspace';
import { modelingCommandFr } from './fr/modeling-command';
import { moveRotateFr } from './fr/move-rotate';
import { multiSplitFr } from './fr/multi-split';
import { mutationPermissionFr } from './fr/mutation-permission';
import { newIfcFr } from './fr/new-ifc';
import { panelNoModelFr } from './fr/panel-no-model';
import { placementPanelFr } from './fr/placement-panel';
import { planHandlesFr } from './fr/plan-handles';
import { profileSectionFr } from './fr/profile-section';
import { propertiesPanelFr } from './fr/properties-panel';
import { propertiesSelectionFr } from './fr/properties-selection';
import { propertiesFr } from './fr/properties';
import { propertyEditorFr } from './fr/property-editor';
import { pushPullAlignFr } from './fr/push-pull-align';
import { relationshipCardFr } from './fr/relationship-card';
import { remeshFr } from './fr/remesh';
import { repositionPanelFr } from './fr/reposition-panel';
import { resultViewFr } from './fr/result-view';
import { retainedGeometryFr } from './fr/retained-geometry';
import { reviewWorkspaceFr } from './fr/review-workspace';
import { ribbonToolbarFr } from './fr/ribbon-toolbar';
import { roomLayoutFr } from './fr/room-layout';
import { roomReviewFr } from './fr/room-review';
import { roomToolFr } from './fr/room-tool';
import { scanToBimFr } from './fr/scan-to-bim';
import { sceneActionsFr } from './fr/scene-actions';
import { scheduleFr } from './fr/schedule';
import { scriptPanelFr } from './fr/script-panel';
import { searchFiltersFr } from './fr/search-filters';
import { searchModalFr } from './fr/search-modal';
import { section2dFr } from './fr/section-2d';
import { sectionPlanesFr } from './fr/section-planes';
import { sectionToolFr } from './fr/section-tool';
import { semanticAssistFr } from './fr/semantic-assist';
import { semanticIdentityFr } from './fr/semantic-identity';
import { semanticResultsFr } from './fr/semantic-results';
import { semanticFr } from './fr/semantic';
import { settingsFr } from './fr/settings';
import { sharedCommandsFr } from './fr/shared-commands';
import { sheetsPdfFr } from './fr/sheets-pdf';
import { shellChromeFr } from './fr/shell-chrome';
import { sourcesFr } from './fr/sources';
import { spaceEnvelopeFr } from './fr/space-envelope';
import { splitToolFr } from './fr/split-tool';
import { stairRailingFr } from './fr/stair-railing';
import { storeyContextFr } from './fr/storey-context';
import { structuralPropertiesFr } from './fr/structural-properties';
import { structuralReviewFr } from './fr/structural-review';
import { sweptDiskInspectionFr } from './fr/swept-disk-inspection';
import { tableCorrectionsFr } from './fr/table-corrections';
import { terrainImageryFr } from './fr/terrain-imagery';
import { toursFr } from './fr/tours';
import { trimExtendFr } from './fr/trim-extend';
import { validationEditorFr } from './fr/validation-editor';
import { validationPanelFr } from './fr/validation-panel';
import { viewerShellFr } from './fr/viewer-shell';
import { viewportLightingFr } from './fr/viewport-lighting';
import { visibilityReasonsFr } from './fr/visibility-reasons';
import { webgpuTroubleshootingFr } from './fr/webgpu-troubleshooting';
import { workspaceMigrationFr } from './fr/workspace-migration';
import { zoneEmissionFr } from './fr/zone-emission';
import { zonesPanelFr } from './fr/zones-panel';

export default {
  ...activityTrayFr,
  ...aiReportsFr,
  ...alignmentSectionFr,
  ...analysisPanelFr,
  ...annotationsFr,
  ...anonymizedExportFr,
  ...appearanceAssignmentListFr,
  ...appearanceAssignmentMembersFr,
  ...appearancePanelFr,
  ...appearancePickersFr,
  ...appearanceWorkflowsFr,
  ...assistantArtifactsFr,
  ...assistantPackAutomationFr,
  ...assistantPackChecksFr,
  ...assistantPackCoordinationFr,
  ...assistantPackMeasureFr,
  ...assistantPackSiteFr,
  ...assistantPackTablesFr,
  ...assistantReuseFr,
  ...assistantSourcesFr,
  ...assistantUsageFr,
  ...assistantWorkbenchFr,
  ...attributeEditorFr,
  ...automationEditorFr,
  ...bcfDraftsFr,
  ...bcfFr,
  ...bulkPropertyEditorFr,
  ...capturedArtifactsFr,
  ...cesiumGeoFr,
  ...changeSetsFr,
  ...changesPanelFr,
  ...chartsFr,
  ...chatByokFr,
  ...chatFr,
  ...checkAuthoringFr,
  ...clashGroupApplyFr,
  ...clashGroupsFr,
  ...clashPanelFr,
  ...clashQualityFr,
  ...clashToolsFr,
  ...commandPaletteFr,
  ...commandsFr,
  ...compareAnalysisFr,
  ...compareKeyPropertyFr,
  ...comparePanelFr,
  ...copyArrayFr,
  ...costPanelFr,
  ...costReviewFr,
  ...curtainGridFr,
  ...customGroupingFr,
  ...dataConnectorFr,
  ...deviationStatsFr,
  ...documentMenuFr,
  ...documentFr,
  ...drawingUnderlayFr,
  ...errorReportFr,
  ...exportDialogFr,
  ...extensionsFlavorsFr,
  ...extensionsPanelsFr,
  ...extrusionInspectionFr,
  ...filterGroupsFr,
  ...filterOperatorsFr,
  ...flowAssistantFr,
  ...flowPanelFr,
  ...flowReviewFr,
  ...flowStartupFr,
  ...ganttWorkCalendarFr,
  ...gaussianCaptureFr,
  ...geometryExportDialogsFr,
  ...georeferencingFr,
  ...groupReviewFr,
  ...hierarchyFr,
  ...hostedPlaceFr,
  ...idsAgentFr,
  ...idsPanelFr,
  ...idsStudioFr,
  ...ifcFederationAssumptionsFr,
  ...influxFr,
  ...ionUploadFr,
  ...keyboardShortcutsFr,
  ...landXmlGeorefAssumptionsFr,
  ...landXmlTerrainExportFr,
  ...landXmlFr,
  ...layersPanelFr,
  ...lensPanelFr,
  ...listsFr,
  ...manualValidationFr,
  ...mcpPlaygroundFr,
  ...mcpFr,
  ...measureFr,
  ...mergeLayersBannerFr,
  ...miscPanelsAFr,
  ...miscPanelsBFr,
  ...modelAuthoringFr,
  ...modelChangesFr,
  ...modelInspectorFr,
  ...modelWorkspaceFr,
  ...modelingCommandFr,
  ...moveRotateFr,
  ...multiSplitFr,
  ...mutationPermissionFr,
  ...newIfcFr,
  ...panelNoModelFr,
  ...placementPanelFr,
  ...planHandlesFr,
  ...profileSectionFr,
  ...propertiesPanelFr,
  ...propertiesSelectionFr,
  ...propertiesFr,
  ...propertyEditorFr,
  ...pushPullAlignFr,
  ...relationshipCardFr,
  ...remeshFr,
  ...repositionPanelFr,
  ...resultViewFr,
  ...retainedGeometryFr,
  ...reviewWorkspaceFr,
  ...ribbonToolbarFr,
  ...roomLayoutFr,
  ...roomReviewFr,
  ...roomToolFr,
  ...scanToBimFr,
  ...sceneActionsFr,
  ...scheduleFr,
  ...scriptPanelFr,
  ...searchFiltersFr,
  ...searchModalFr,
  ...section2dFr,
  ...sectionPlanesFr,
  ...sectionToolFr,
  ...semanticAssistFr,
  ...semanticIdentityFr,
  ...semanticResultsFr,
  ...semanticFr,
  ...settingsFr,
  ...sharedCommandsFr,
  ...sheetsPdfFr,
  ...shellChromeFr,
  ...sourcesFr,
  ...spaceEnvelopeFr,
  ...splitToolFr,
  ...stairRailingFr,
  ...storeyContextFr,
  ...structuralPropertiesFr,
  ...structuralReviewFr,
  ...sweptDiskInspectionFr,
  ...tableCorrectionsFr,
  ...terrainImageryFr,
  ...toursFr,
  ...trimExtendFr,
  ...validationEditorFr,
  ...validationPanelFr,
  ...viewerShellFr,
  ...viewportLightingFr,
  ...visibilityReasonsFr,
  ...webgpuTroubleshootingFr,
  ...workspaceMigrationFr,
  ...zoneEmissionFr,
  ...zonesPanelFr,
  ...registryFr,
  ...storeyManagerFr,
} satisfies Catalogue;
