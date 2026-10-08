/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export const semanticIdentityEn = {
  'semantic.identityControls': 'IFC identity strategy',
  'semantic.identityUri': 'Resource URI contains IFC GlobalId',
  'semantic.identityUriMode': 'Resource URI matching',
  'semantic.identityUriTemplateMode': 'Full URI template',
  'semantic.identityUriSegmentMode': 'Last path segment (opt in)',
  'semantic.identityUriTemplate': 'Full resource URI template',
  'semantic.identityUriApply': 'Apply URI template',
  'semantic.identityUriHint': 'The template uses one {GlobalId} placeholder. Last path segment needs known resource URIs for reverse queries. URI matching never replaces the selected direct GlobalId strategy.',
  'semantic.identityDirect': 'IFC GlobalId and model revision',
  'semantic.identityLinks': 'Explicit resource links',
  'semantic.identityProfile': 'Profile identity fields',
  'semantic.identityGuidField': 'Profile GlobalId field',
  'semantic.identityRevisionField': 'Profile revision field',
  'semantic.identityNoRevision': 'No revision field',
  'semantic.identityLinkJson': 'Resource links (JSON)',
  'semantic.identityApplyLinks': 'Apply resource links',
  'semantic.identityLinkHint': 'Use resourceId, modelRevision and GlobalId. Model revisions require an explicit association to a loaded model.',
} as const;
