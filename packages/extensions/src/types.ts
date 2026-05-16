/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared types for @ifc-lite/extensions.
 *
 * The manifest schema mirrors `docs/architecture/ai-customization/01-extension-model.md §1`.
 * Capability grammar mirrors `02-security.md §3`. Keep this file in sync with
 * the RFC; the schema is authoritative.
 */

// ============================================================================
// Result type — used everywhere validation can fail.
// ============================================================================

export interface ValidationError {
  /** JSONPath-like path into the input (e.g. `contributes.toolbar[0].command`). */
  path: string;
  /** Stable error code for programmatic handling. */
  code: ValidationErrorCode;
  /** Human-readable message. */
  message: string;
  /** Optional remediation hint shown to authors / repair loop. */
  hint?: string;
}

export type ValidationErrorCode =
  | 'required'
  | 'type_mismatch'
  | 'unknown_field'
  | 'invalid_value'
  | 'invalid_format'
  | 'invalid_capability'
  | 'invalid_when'
  | 'invalid_slot'
  | 'invalid_id'
  | 'invalid_semver'
  | 'invalid_engine_range'
  | 'invalid_activation'
  | 'invalid_reference'
  | 'invalid_widget'
  | 'invalid_manifest_version';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationError[] };

// ============================================================================
// Capability grammar
// ============================================================================

export type CapabilityScope =
  | 'model'
  | 'viewer'
  | 'export'
  | 'storage'
  | 'network'
  | 'command'
  | 'ui';

/** Parsed capability — produced by `parseCapability`. */
export interface Capability {
  /** The original capability string (for round-tripping). */
  raw: string;
  scope: CapabilityScope;
  action: string;
  /**
   * Target pattern, if a `:target` was provided. `undefined` means the
   * capability has no target (e.g. `model.read`, `model.create`).
   */
  target?: CapabilityTarget;
}

export interface CapabilityTarget {
  /** Original target string. */
  raw: string;
  /** Pre-compiled matcher segments — see `capability/match.ts`. */
  segments: CapabilityTargetSegment[];
  /** True iff the target is `*` (matches anything). */
  isUniversalWildcard: boolean;
}

export type CapabilityTargetSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'glob' }; // matches a single segment

export type RiskTier = 'green' | 'yellow' | 'red';

export interface CapabilityRisk {
  capability: Capability;
  tier: RiskTier;
  /** Plain-English description shown in the review screen. */
  description: string;
}

/** Result of diffing two capability sets. */
export interface CapabilityDiff {
  added: Capability[];
  removed: Capability[];
  unchanged: Capability[];
}

// ============================================================================
// When clause language
// ============================================================================

export type WhenExpression =
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'identifier'; name: string }
  | { kind: 'not'; operand: WhenExpression }
  | { kind: 'and'; left: WhenExpression; right: WhenExpression }
  | { kind: 'or'; left: WhenExpression; right: WhenExpression }
  | { kind: 'compare'; op: WhenCompareOp; left: WhenExpression; right: WhenExpression };

export type WhenCompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

/** Context values available to `when` clauses. Extend cautiously. */
export interface WhenContext {
  [key: string]: WhenValue;
}

export type WhenValue = string | number | boolean | undefined;

// ============================================================================
// Activation events
// ============================================================================

export type ActivationEvent =
  | 'onStartup'
  | 'onModelLoad'
  | `onCommand:${string}`
  | `onLens:${string}`
  | `onExporter:${string}`
  | `onIdsValidator:${string}`
  | `onSchema:${string}`
  | `onSlot:${string}`;

// ============================================================================
// Manifest schema (v1)
// ============================================================================

export interface ExtensionManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  description: string;
  version: string;
  author?: ManifestAuthor;
  license?: string;
  engines: { ifcLiteSdk: string };
  capabilities: string[];
  activation: ActivationEvent[];
  contributes?: ManifestContributions;
  entry: ManifestEntry;
  tests?: ManifestTest[];
  l10n?: Record<string, Record<string, string>>;
  readme?: string;
}

export interface ManifestAuthor {
  name: string;
  url?: string;
  email?: string;
}

export interface ManifestEntry {
  activate?: string;
  deactivate?: string;
  commands?: Record<string, string>;
  triggers?: Record<string, string>;
}

export interface ManifestContributions {
  commands?: CommandContribution[];
  toolbar?: ToolbarContribution[];
  dock?: DockContribution[];
  contextMenu?: ContextMenuContribution[];
  keybindings?: KeybindingContribution[];
  lenses?: LensContribution[];
  exporters?: ExporterContribution[];
  idsValidators?: IdsValidatorContribution[];
  statusBar?: StatusBarContribution[];
}

export interface CommandContribution {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  paletteCategory?: string;
}

export type ToolbarSlot = 'toolbar.left' | 'toolbar.right' | 'toolbar.center';

export interface ToolbarContribution {
  command: string;
  slot: ToolbarSlot;
  when?: string;
  order?: number;
}

export type DockSlot = 'dock.left' | 'dock.right' | 'dock.bottom';

export interface DockContribution {
  id: string;
  slot: DockSlot;
  title: string;
  icon?: string;
  widget: string;
  when?: string;
}

export type ContextMenuSlot =
  | 'contextMenu.entity'
  | 'contextMenu.canvas'
  | 'contextMenu.tree';

export interface ContextMenuContribution {
  command: string;
  slot: ContextMenuSlot;
  when?: string;
  group?: string;
}

export interface KeybindingContribution {
  command: string;
  key: string;
  when?: string;
}

export interface LensContribution {
  id: string;
  name: string;
  description?: string;
  evaluator: string;
}

export interface ExporterContribution {
  id: string;
  name: string;
  mimeType: string;
  extension: string;
  handler: string;
}

export interface IdsValidatorContribution {
  id: string;
  name: string;
  handler: string;
}

export type StatusBarSlot = 'statusBar.left' | 'statusBar.right';

export interface StatusBarContribution {
  id: string;
  slot: StatusBarSlot;
  text: string;
  command?: string;
  when?: string;
  order?: number;
}

export interface ManifestTest {
  name: string;
  command: string;
  fixture: string;
  args?: Record<string, unknown>;
  expect: ManifestTestExpect;
}

export interface ManifestTestExpect {
  mimeType?: string;
  minBytes?: number;
  maxBytes?: number;
  regex?: string;
  jsonShape?: Record<string, unknown>;
}

// ============================================================================
// Bundle layout
// ============================================================================

/** An in-memory representation of an extension on disk or unpacked from .iflx. */
export interface Bundle {
  manifest: ExtensionManifest;
  /** Map from relative path → file contents. */
  files: Map<string, BundleFile>;
  /** Optional source descriptor (for diagnostics). */
  source?: BundleSource;
}

export interface BundleFile {
  /** Path relative to the bundle root, forward-slash normalised. */
  path: string;
  /** Raw file bytes. */
  bytes: Uint8Array;
  /** Best-effort decoded text. Undefined for binary files. */
  text?: string;
}

export interface BundleSource {
  kind: 'directory' | 'iflx' | 'memory';
  /** Best-effort origin description — directory path, URL, etc. */
  origin?: string;
}

// ============================================================================
// Slot registry
// ============================================================================

/** A contribution registered by an extension into a named slot. */
export interface SlotContribution<T = unknown> {
  /** Extension id that contributed this. */
  extensionId: string;
  /** Slot identifier (e.g. `toolbar.right`, `commandPalette`). */
  slot: string;
  /** Original contribution payload from the manifest. */
  payload: T;
}

export type SlotListener<T = unknown> = (
  contributions: SlotContribution<T>[],
) => void;
