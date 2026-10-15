/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared headless host adapters. All reads include the supplied live mutation overlay. */
export { createQueryAdapter, expandTypes, isProductType } from './headless/backend-query.js';
export { overlayFromView, pendingOverlay, foldedTypeCounts, foldedEntityCount, pendingMutationsField, stepText, type CreatedEntity, type PendingOverlay } from './headless/overlay.js';
export { effectiveSourceIds, pendingEntityMembership } from './headless/effective-entity-membership.js';
export { entityInfoInSchema, entityInfoAcrossSchemas } from './headless/schema-tables.js';
export { HeadlessBackend } from './headless/backend.js';
export type { HeadlessBackendOptions } from './headless/options.js';
export { openModel, HeadlessSessionClosedError } from './headless/session.js';
export type { HeadlessModelSession, OpenModelOptions } from './headless/session.js';
