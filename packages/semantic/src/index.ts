/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { GUID_PATTERN, LIMITS, assertIri } from './types.js';
export type { RdfBinding, SparqlResults, SemanticRecord, SemanticDataset } from './types.js';
export { parseResults, recordsFromResults } from './results.js';
export { assertReadOnlyQuery, inspectReadOnlyQuery, relatedResourceQuery, relatedIdentityQuery } from './query.js';
export type { ReadOnlyQueryShape } from './query.js';
export { createSemanticProvider, request } from './provider.js';
export type { SemanticProvider, ProviderReadOptions, ProviderResult } from './provider.js';
export { ResolverRegistry, IFC_GLOBAL_ID_STRATEGY, resolveResource, createResourceLinkStrategy, createProfileMappingStrategy } from './resolver.js';
export type { EntityAddress, LiveEntity, Resolution, IdentityRecord, ResolverContext, IdentityStrategy, ResourceIdentityLink } from './resolver.js';
export { exportWorkspace, importWorkspace, sanitizeSource } from './workspace.js';
export type { SemanticWorkspace, WorkspaceQuery, RevisionLink, ImportedWorkspace } from './workspace.js';
export * from './profile-index.js';
export { resourcesFromResults, DEFAULT_MAPPING } from './projection.js';
export type { BindingMapping } from './projection.js';
export { recordsFromGraph } from './graph.js';
export { DEFAULT_RESOURCE_URI_CONFIG, assertResourceUriIdentityConfig, resourceUriForGlobalId, createResourceUriStrategy } from './uri-resolver.js';
export type { ResourceUriIdentityConfig } from './uri-resolver.js';
