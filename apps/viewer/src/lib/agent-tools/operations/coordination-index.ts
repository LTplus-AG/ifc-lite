/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { coordinationBcfPageOperations } from './coordination-bcf-pages';
import { documentNativeReportOperations } from './document-native-report';
import { documentNativeReportDraftOperations } from './document-native-report-draft';
import { coordinationAssistantAttachmentOperations } from './coordination-assistant-attachments';
import { coordinationPortableOperations } from './coordination-portable';
import { coordinationBcfRecoveryOperations } from './coordination-bcf-recovery';
import { coordinationCollabOperations } from './coordination-collab';
import { coordinationBcfServerOperations } from './coordination-bcf-server';
import { coordinationBcfDraftOperations } from './coordination-bcf-drafts';
import { coordinationCompareWorkspaceOperations } from './coordination-compare-workspace';
import { coordinationAssistantOperations } from './coordination-assistant';
import { coordinationViewpointOperations } from './coordination-viewpoints';
import { coordinationBcfOperations } from './coordination-bcf';
import { coordinationCompareOperations } from './coordination-compare';
import { coordinationReviewOperations } from './coordination-review';
export const coordinationOperations = [...coordinationBcfPageOperations, ...documentNativeReportOperations, ...documentNativeReportDraftOperations, ...coordinationAssistantAttachmentOperations, ...coordinationPortableOperations, ...coordinationBcfRecoveryOperations, ...coordinationCollabOperations, ...coordinationBcfServerOperations, ...coordinationBcfDraftOperations, ...coordinationCompareWorkspaceOperations, ...coordinationAssistantOperations, ...coordinationViewpointOperations, ...coordinationBcfOperations, ...coordinationCompareOperations,
  ...coordinationReviewOperations];
