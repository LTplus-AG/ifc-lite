/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/extensions — Extension model and capability grammar for IFClite.
 *
 * Phase 0 surface. UI-host integration (loader, runtime, slot rendering)
 * is added in Phase 1. AI authoring (Phase 2), flavors (Phase 3), and
 * self-improvement loops (Phase 4) follow.
 *
 * See docs/architecture/ai-customization/ for the full design.
 */

// ---------- Types
export type {
  ActivationEvent,
  Bundle,
  BundleFile,
  BundleSource,
  Capability,
  CapabilityDiff,
  CapabilityRisk,
  CapabilityScope,
  CapabilityTarget,
  CapabilityTargetSegment,
  CommandContribution,
  ContextMenuContribution,
  ContextMenuSlot,
  DockContribution,
  DockSlot,
  ExporterContribution,
  ExtensionManifest,
  IdsValidatorContribution,
  KeybindingContribution,
  LensContribution,
  ManifestAuthor,
  ManifestContributions,
  ManifestEntry,
  ManifestTest,
  ManifestTestExpect,
  RiskTier,
  SlotContribution,
  SlotListener,
  StatusBarContribution,
  StatusBarSlot,
  ToolbarContribution,
  ToolbarSlot,
  ValidationError,
  ValidationErrorCode,
  ValidationResult,
  WhenCompareOp,
  WhenContext,
  WhenExpression,
  WhenValue,
} from './types.js';

// ---------- Manifest
export { validateManifest } from './manifest/index.js';

// ---------- Migrations
export { migrateManifest, CURRENT_MANIFEST_VERSION } from './migrations/index.js';

// ---------- Capability
export * from './capability/index.js';

// ---------- When
export * from './when/index.js';

// ---------- Slot registry
export { SlotRegistry } from './slot-registry.js';

// ---------- Bundle
export * from './bundle/index.js';

// ---------- Storage
export * from './storage/index.js';

// ---------- Host (loader + activation dispatcher)
export * from './host/index.js';

// ---------- Audit log
export * from './audit/index.js';

// ---------- Capability inference (for promote-to-tool UX)
export * from './inference/index.js';

// ---------- Signing (Phase 5 prototype)
export * from './signing/index.js';

// ---------- Flavors (Phase 3 library)
export * from './flavor/index.js';

// ---------- Action log + miner (Phase 4 library)
export * from './log/index.js';
export * from './miner/index.js';

// ---------- Authoring plan + widget DSL + code validation (Phase 2 library)
export * from './authoring/index.js';
export * from './widget/index.js';
export * from './validate/index.js';
export * from './testing/index.js';
export * from './dryrun/index.js';
