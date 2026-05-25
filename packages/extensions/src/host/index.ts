/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {
  ExtensionLoader,
  manifestToContributions,
  type ExtensionLoaderOptions,
  type LoadedExtensionStatus,
} from './loader.js';
export { ActivationDispatcher, type ActivationListener } from './activation.js';
export {
  capabilitiesToPermissions,
  type SandboxPermissionsLike,
} from './permissions.js';
export {
  ExtensionRuntime,
  EntrySourceError,
  type ExtensionRuntimeOptions,
  type RuntimeSandboxHandle,
  type RuntimeSandboxFactory,
  type RuntimeSandboxCreateOptions,
  type RuntimeRunOptions,
  type RuntimeRunResult,
  type RuntimeLogEntry,
  type ActivationRecord,
  type ExtensionContextV1,
} from './runtime.js';
export { wrapEntrySource, type SourceWrapOptions } from './source-wrap.js';
export {
  createMemorySandboxFactory,
  type MemorySandboxFactoryOptions,
} from './memory-factory.js';
export {
  checkMethodCall,
  assertMethodCall,
  CapabilityDeniedError,
} from './check.js';
export {
  evaluateCompatibility,
  findAffected,
  type Compatibility,
  type CompatibilityResult,
  type InstalledForCompatCheck,
} from './sdk-version.js';
export {
  revalidateAgainstSdk,
  type RevalidationItem,
  type RevalidationSummary,
  type RevalidateOptions,
} from './sdk-revalidate.js';
