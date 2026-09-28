/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type {
  CommitArtifact,
  CommitCapabilities,
  CommitEvent,
  CommitPayload,
  CommitPayloadFormat,
  CommitRef,
  CommitStats,
  CommitStatus,
  CommitWatchResult,
  ListCommitsOptions,
  LoadCommitOptions,
  ModelRef,
  SourceCommit,
  SourceModel,
} from './commits.js';

export type {
  CommitFingerprintSet,
  ElementHistoryEntry,
  ElementHistoryQuery,
  ElementHistoryState,
  GetCommitDiffOptions,
  IdentityEntryLike,
  IdentityRecordSet,
  LoadFingerprintsOptions,
  SourceFingerprint,
  StoredChangeKind,
  StoredCommitDiff,
  StoredDiffEntry,
  StoredDiffState,
} from './commit-history.js';

export type {
  CreateCommitInput,
  CreateModelInput,
  RevisionDecision,
  RevisionResolutionRecord,
} from './commit-write.js';

export type { CommitSourceMethods, ListModelsOptions } from './commit-provider.js';

export { isCommitSourceError } from './commit-errors.js';
export type { CommitSourceErrorCode, CommitSourceErrorLike } from './commit-errors.js';

export type {
  ConnectionTestResult,
  DownloadOptions,
  DropdownOption,
  FileFilter,
  FileSourceProvider,
  KeyValueStore,
  ListOptions,
  ListProjectsOptions,
  Logger,
  Page,
  PluginAuthKind,
  PluginContext,
  PluginContributions,
  PluginManifest,
  PluginPermissions,
  PluginPreference,
  PluginPreferenceType,
  ProviderCapabilities,
  PublicFetchInit,
  RelayDeclaration,
  RevisionEvent,
  RevisionWatchResult,
  SourceAuth,
  SourceContainer,
  SourceFile,
  SourceFileRef,
  SourceIdentity,
  SourceProject,
  SourceRevision,
  SourceTag,
} from './types.js';

export { PLUGIN_API_VERSION, matchesGlob, satisfiesCaretRange } from './version.js';
