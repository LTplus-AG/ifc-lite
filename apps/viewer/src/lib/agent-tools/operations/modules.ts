/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Source-owned feature arrays; build derives verified contracts and lazy loaders. */
const modules = [
  ['view', 'viewOperations'],
  ['reads', 'readOperations'],
  ['environment', 'environmentOperations'],
  ['validation', 'validationOperations'],
  ['measurements', 'measurementOperations'],
  ['pointclouds', 'pointCloudOperations'],
  ['queries', 'queryOperations'],
  ['preferences', 'preferenceOperations'],
  ['hierarchy', 'hierarchyOperations'],
  ['fields', 'fieldOperations'],
  ['sections-native', 'nativeSectionOperations'],
  ['annotations', 'annotationOperations'],
  ['search', 'searchOperations'],
  ['picking', 'pickingOperations'],
] as const;
export const operationModules = modules.map(([module, exportName]) => ({ module, exportName }));
