/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * BCF panel catalogue (#4918 slice: BCF). Covers the nine `bcf/` components
 * plus `BCFPanel.tsx`'s own chrome: topic create/edit form, the OpenCDE
 * server sign-in dialog and its connect form, the topic list and detail
 * views, the 3D/2D viewpoint-capture buttons, the server-control trigger,
 * and `bcfHelpers.tsx`'s status badge default. Chrome shared by more than
 * one of those surfaces (Close/Cancel/Save, the "your@email.com" author
 * placeholder) lives under `bcf.shared.*` instead of being duplicated per
 * component.
 *
 * Out of scope: BCF topic titles, descriptions, authors, GUIDs, comments,
 * labels, and dates are runtime model content supplied by the loaded or
 * imported BCF project, never literals here. `TOPIC_TYPES`/`TOPIC_STATUSES`/
 * `PRIORITIES` in `bcfHelpers.tsx` stay literal English: they are the actual
 * `topic.topicType`/`topicStatus`/`priority` field VALUES this app writes
 * into exported BCF files, not display-only labels, so translating them
 * would desync the on-screen text from the stored/round-tripped data.
 */
export const bcfEn = {
  // Shared across more than one BCF component.
  'bcf.shared.close': 'Close',
  'bcf.shared.cancel': 'Cancel',
  'bcf.shared.save': 'Save',
  'bcf.shared.emailPlaceholder': 'your@email.com',

  // bcfHelpers.tsx
  'bcf.helpers.statusOpen': 'Open',

  // BCFServerControl.tsx
  'bcf.serverControl.title': 'BCF server',

  // BCFViewpointCaptureButtons.tsx
  'bcf.viewpointCapture.capture3d': 'Capture 3D',
  'bcf.viewpointCapture.capture2dDefaultTitle': 'Attach the visible annotated 2D section',
  'bcf.viewpointCapture.capture2dAria': 'Capture current 2D section as viewpoint',
  'bcf.viewpointCapture.capture2d': 'Capture 2D',

  // BCFCreateTopicForm.tsx
  'bcf.createForm.titleLabel': 'Title *',
  'bcf.createForm.titlePlaceholder': 'Brief description of the topic',
  'bcf.createForm.descriptionLabel': 'Description',
  'bcf.createForm.descriptionPlaceholder': 'Detailed description (optional)',
  'bcf.createForm.attachSnapshot': 'Attach snapshot',
  'bcf.createForm.recapture': 'Recapture',
  'bcf.createForm.snapshotAlt': 'Viewpoint snapshot',
  'bcf.createForm.noSnapshot': 'No snapshot captured',
  'bcf.createForm.typeLabel': 'Type',
  'bcf.createForm.statusLabel': 'Status',
  'bcf.createForm.priorityLabel': 'Priority',
  'bcf.createForm.dueDateLabel': 'Due date',
  'bcf.createForm.assigneeLabel': 'Assignee',
  'bcf.createForm.assigneePlaceholder': 'name@example.com',
  'bcf.createForm.labelsLabel': 'Labels',
  'bcf.createForm.labelsPlaceholder': 'Comma-separated (e.g. architecture, urgent)',

  // BCFServerConnectForm.tsx
  'bcf.serverConnect.serverLabel': 'Server',
  'bcf.serverConnect.serverUrlLabel': 'Server URL',
  'bcf.serverConnect.serverUrlPlaceholder': 'https://example.com/bcf',
  'bcf.serverConnect.authMethodLabel': 'Sign-in method',
  'bcf.serverConnect.emailLabel': 'Email',
  'bcf.serverConnect.emailPlaceholder': 'you@example.com',
  'bcf.serverConnect.passwordLabel': 'Password',
  'bcf.serverConnect.accessTokenLabel': 'Access token',
  'bcf.serverConnect.accessTokenPlaceholder': 'Paste an access token',
  'bcf.serverConnect.vendorAppNotice':
    'Signs you in with your {vendor} account through the {vendor} app registered to IFClite. No client id to enter.',
  'bcf.serverConnect.clientIdLabel': 'Client ID',
  'bcf.serverConnect.clientIdPlaceholderVendorOnly': 'Issued by the vendor to application developers',
  'bcf.serverConnect.clientIdPlaceholderAutoRegister': 'Leave empty to auto-register when supported',
  'bcf.serverConnect.clientIdHelpVendorOnly':
    '{vendor} issues client ids to application vendors, not to space users. Ask whoever runs this IFClite deployment to configure its {vendor} app.',
  'bcf.serverConnect.clientIdHelpDefault':
    'From an OAuth app registered with the vendor. Servers offering dynamic client registration need no ID; leave it empty.',
  'bcf.serverConnect.clientSecretOptionalLabel': 'Client secret (optional)',
  'bcf.serverConnect.redirectUriNotice': 'The OAuth app must allow this redirect URI:',
  'bcf.serverConnect.clientSecretLabel': 'Client secret',
  'bcf.serverConnect.passwordNotice':
    "The password is exchanged for an access token and never stored. The token is kept in this browser's local storage, unencrypted. Treat it as revocable, not secret.",
  'bcf.serverConnect.credentialsNotice':
    "Credentials are kept in this browser's local storage, unencrypted. Treat them as revocable, not secret.",
  'bcf.serverConnect.connect': 'Connect',
  'bcf.serverConnect.missingClientId':
    '{vendor} issues client ids to application vendors, not to space users, and this IFClite deployment has no {vendor} app configured ({envPrefix}_CLIENT_ID). Sign in via browser is unavailable here.',
  'bcf.serverConnect.popupBlocked': 'Sign-in popup was blocked. Allow popups for this site and try again.',
  'bcf.serverConnect.oauthTimeout': 'The BCF server sign-in was not completed within 5 minutes.',

  // BCFServerDialog.tsx
  'bcf.serverDialog.title': 'BCF Server',
  'bcf.serverDialog.signedInAs': 'Signed in as {user} · {server}',
  'bcf.serverDialog.projectLabel': 'Project',
  'bcf.serverDialog.loadingProjects': 'Loading projects…',
  'bcf.serverDialog.noProjects': 'No projects available.',
  'bcf.serverDialog.selectProjectPlaceholder': 'Select a project…',
  'bcf.serverDialog.fetchingTopics': 'Fetching topics… {loaded}',
  'bcf.serverDialog.loadingTopicDetails': 'Loading topic details… {loaded}',
  'bcf.serverDialog.loadingTopicDetailsWithTotal': 'Loading topic details… {loaded} / {total}',
  'bcf.serverDialog.replaceWarning': {
    one: 'Loading will replace the {count} topic currently in the BCF panel. Export them first if they are not saved anywhere.',
    other:
      'Loading will replace the {count} topics currently in the BCF panel. Export them first if they are not saved anywhere.',
  },
  'bcf.serverDialog.disconnect': 'Disconnect',
  'bcf.serverDialog.replaceAndLoad': 'Replace and load',
  'bcf.serverDialog.loadTopics': 'Load topics',
  'bcf.serverDialog.syncWarnings': 'Loaded {count} topics ({skipped} items skipped — see console)',
  'bcf.serverDialog.syncSuccess': 'Loaded {count} topics from the BCF server',

  // BCFTopicDetail.tsx
  'bcf.topicDetail.zoomToTopicAria': 'Zoom to topic',
  'bcf.topicDetail.zoomTo': 'Zoom to',
  'bcf.topicDetail.editTopic': 'Edit topic',
  'bcf.topicDetail.deleteTopicAria': 'Delete topic',
  'bcf.topicDetail.createdByOn': 'Created by {author} on {date}',
  'bcf.topicDetail.createdBy': 'Created by {author}',
  'bcf.topicDetail.createdOn': 'Created on {date}',
  'bcf.topicDetail.assignedTo': 'Assigned to: {name}',
  'bcf.topicDetail.due': 'Due: {date}',
  'bcf.topicDetail.viewpointsHeading': 'Viewpoints',
  'bcf.topicDetail.captureWillInclude': 'Capture will include:',
  'bcf.topicDetail.selectedObjects': {
    one: '{count} selected object',
    other: '{count} selected objects',
  },
  'bcf.topicDetail.isolatedObjects': 'Isolated objects (others hidden)',
  'bcf.topicDetail.hiddenObjects': 'Hidden objects',
  'bcf.topicDetail.noViewpoints': 'No viewpoints captured',
  'bcf.topicDetail.viewpointAlt': 'Viewpoint',
  'bcf.topicDetail.deleteViewpointAria': 'Delete viewpoint',
  'bcf.topicDetail.commentCount': {
    one: '{count} comment',
    other: '{count} comments',
  },
  'bcf.topicDetail.commentAction': 'Comment',
  'bcf.topicDetail.goToView': 'Go to view',
  'bcf.topicDetail.commentsHeading': 'Comments ({count})',
  'bcf.topicDetail.associatedViewpointAlt': 'Associated viewpoint',
  'bcf.topicDetail.selectedViewpointAlt': 'Selected viewpoint',
  'bcf.topicDetail.commentingOnViewpoint': 'Commenting on viewpoint',
  'bcf.topicDetail.cancelViewpointCommentAria': 'Cancel viewpoint comment',
  'bcf.topicDetail.addCommentOnViewpointPlaceholder': 'Add comment on viewpoint...',
  'bcf.topicDetail.addCommentPlaceholder': 'Add a comment...',
  'bcf.topicDetail.sendCommentAria': 'Send comment',
  'bcf.topicDetail.deleteConfirmTitle': 'Delete Topic?',
  'bcf.topicDetail.deleteConfirmBody':
    'This will permanently delete this topic and all its comments and viewpoints.',
  'bcf.topicDetail.deleteConfirmButton': 'Delete',

  // BCFTopicList.tsx
  'bcf.topicList.allStatuses': 'All statuses',
  'bcf.topicList.newTopicAria': 'New topic',
  'bcf.topicList.noTopics': 'No topics',
  'bcf.topicList.createFirstTopic': 'Create first topic',
  'bcf.topicList.emailAuthorshipLabel': 'Your email for BCF authorship',
  'bcf.topicList.authorLabel': 'Author',
  'bcf.topicList.editAuthorEmailAria': 'Edit author email',
  'bcf.topicList.setEmail': 'Set email',
  'bcf.topicList.setEmailNudge': 'Set your email to identify your topics and comments',

  // BCFPanel.tsx
  'bcf.panel.title': 'BCF Topics',
  'bcf.panel.importTitle': 'Import BCF',
  'bcf.panel.exportTitle': 'Export BCF',
  'bcf.panel.hideMarkers': 'Hide 3D markers',
  'bcf.panel.showMarkers': 'Show 3D markers',
  'bcf.panel.setAuthorTitle': 'Set author',
  'bcf.panel.setAuthorHeading': 'Set Author Email',
  'bcf.panel.importDialogTitle': 'Import BCF File',
  'bcf.panel.bcfFilterName': 'BCF Files',
  'bcf.panel.allFilesFilterName': 'All Files',
  'bcf.panel.untitledTopic': 'Untitled',
  'bcf.panel.importError': 'Failed to import BCF file',
  'bcf.panel.exportError': 'Failed to export BCF file',
} as const satisfies Record<string, TranslationValue>;
