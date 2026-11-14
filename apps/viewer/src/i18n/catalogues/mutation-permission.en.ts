/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export const mutationPermissionEn = {
  'mutationPermission.workflowRunning': 'Wait for the workflow check or PDF capture to finish, or cancel the workflow',
  'mutationPermission.editModeRequired': 'Turn on Edit mode to change this model',
  'mutationPermission.roleRequired': 'Editing requires editor access in this shared session',
  'mutationPermission.modelUnavailable': 'This model has no editable IFC data',
  'mutationPermission.propertiesLoading': 'The model\'s properties are still loading',
  'mutationPermission.propertiesFailed': 'The model\'s properties could not be loaded, so it cannot be edited',
  'mutationPermission.idSpaceExhausted': 'This model does not have enough safe entity IDs for edits in this session',
} as const;
