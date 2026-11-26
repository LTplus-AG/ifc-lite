/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { coordinationBcfPageOperations } from './coordination-bcf-pages';
import { documentNativeReportOperations } from './document-native-report';
import { documentNativeReportDraftOperations } from './document-native-report-draft';
import { coordinationAssistantAttachmentOperations } from './coordination-assistant-attachments';
import { coordinationPortableOperations } from './coordination-portable';
import { coordinationBcfRecoveryOperations } from './coordination-bcf-recovery';
import { coordinationFinalControlOperations } from './coordination-final-controls';
import { coordinationExtensionNativeOperations } from './coordination-extension-native';
import { coordinationFlavorOperations } from './coordination-flavors';
import { coordinationSemanticNativeOperations } from './coordination-semantic-native';
import { coordinationSemanticProjectionOperations } from './coordination-semantic-projection';
import { coordinationLayerWorkflowOperations } from './coordination-layer-workflows';
import { coordinationSourceCatalogOperations } from './coordination-source-catalog';
import { coordinationCollabOperations } from './coordination-collab';
import { coordinationScriptRunOperations } from './coordination-script-run';
import { coordinationBcfServerOperations } from './coordination-bcf-server';
import { coordinationBcfDraftOperations } from './coordination-bcf-drafts';
import { coordinationGeorefOperations } from './coordination-georef';
import { coordinationCompareWorkspaceOperations } from './coordination-compare-workspace';
import { coordinationExtensionLifecycleOperations } from './coordination-extension-lifecycle';
import { coordinationSourceSettingsOperations } from './coordination-source-settings';
import { coordinationFlowRunOperations } from './coordination-flow-run';
import { coordinationAssistantOperations } from './coordination-assistant';
import { coordinationSourceLoadOperations } from './coordination-source-load';
import { coordinationViewpointOperations } from './coordination-viewpoints';
import { coordinationBcfOperations } from './coordination-bcf';
import { coordinationCompareOperations } from './coordination-compare';
import { coordinationFlowOperations } from './coordination-flow';
import { coordinationInfluxOperations } from './coordination-influx';
import { coordinationLayerOperations } from './coordination-layers';
import { coordinationLoadReportOperations } from './coordination-load-report';
import { coordinationProviderOperations } from './coordination-providers';
import { coordinationReviewOperations } from './coordination-review';
import { coordinationScriptSessionOperations } from './coordination-script-session';
import { coordinationSemanticOperations } from './coordination-semantic';
export const coordinationOperations = [...coordinationBcfPageOperations, ...documentNativeReportOperations, ...documentNativeReportDraftOperations, ...coordinationAssistantAttachmentOperations, ...coordinationPortableOperations, ...coordinationBcfRecoveryOperations, ...coordinationFinalControlOperations, ...coordinationExtensionNativeOperations, ...coordinationFlavorOperations, ...coordinationSemanticNativeOperations, ...coordinationSemanticProjectionOperations, ...coordinationLayerWorkflowOperations, ...coordinationSourceCatalogOperations, ...coordinationCollabOperations, ...coordinationScriptRunOperations, ...coordinationBcfServerOperations, ...coordinationBcfDraftOperations, ...coordinationGeorefOperations, ...coordinationCompareWorkspaceOperations, ...coordinationExtensionLifecycleOperations, ...coordinationSourceSettingsOperations, ...coordinationFlowRunOperations, ...coordinationAssistantOperations, ...coordinationSourceLoadOperations, ...coordinationViewpointOperations, ...coordinationBcfOperations, ...coordinationCompareOperations,
  ...coordinationFlowOperations, ...coordinationInfluxOperations, ...coordinationLayerOperations,
  ...coordinationLoadReportOperations, ...coordinationProviderOperations, ...coordinationReviewOperations,
  ...coordinationScriptSessionOperations, ...coordinationSemanticOperations];
