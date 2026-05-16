/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flavor data model.
 *
 * A flavor is a user's complete personalization layer: installed
 * extensions (with pinned versions and granted capabilities), saved
 * lenses, queries, keybindings, layout overrides, and an optional
 * personal AI prompt overlay.
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md.
 */

import type { JsonValue } from '../types.js';

/** Top-level flavor record. */
export interface Flavor {
  schemaVersion: 1;
  /** Local UUID. */
  id: string;
  /** User-facing label. */
  name: string;
  description?: string;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  updatedAt: string;
  /** Installed extensions with pinned version + granted caps. */
  extensions: FlavorExtension[];
  /** User-curated lens presets. Opaque to the flavor system. */
  lenses: SavedLens[];
  /** User-curated query / IDS rule presets. Opaque. */
  savedQueries: SavedQuery[];
  /** Keybinding overrides. */
  keybindings: KeybindingOverride[];
  /** Panel layout. */
  layout: LayoutOverride;
  /** Personal prompt overlay (see 06-self-improvement.md). */
  promptOverlay?: PromptOverlay;
  /** Default settings overrides — opaque to the flavor system. */
  settings: Record<string, JsonValue>;
  /** Optional author / publish metadata. */
  author?: FlavorAuthor;
}

export interface FlavorExtension {
  id: string;
  version: string;
  source: 'local' | 'registry' | 'url';
  /** sha256 hex of the bundle bytes. */
  bundleHash: string;
  /** User-approved capabilities. */
  grantedCapabilities: string[];
  /** User-level config the extension persisted. */
  config?: Record<string, JsonValue>;
  enabled: boolean;
}

export interface SavedLens {
  id: string;
  name: string;
  /** Opaque blob — the lens engine owns the shape. */
  definition: JsonValue;
}

export interface SavedQuery {
  id: string;
  name: string;
  definition: JsonValue;
}

export interface KeybindingOverride {
  command: string;
  key: string;
  when?: string;
}

export interface LayoutOverride {
  /** Opaque shape — the viewer's layout slice owns it. */
  state: Record<string, JsonValue>;
}

export interface PromptOverlay {
  /** Markdown body appended to the system prompt. Capped at ~4000 tokens. */
  content: string;
  /** ISO timestamp of last edit. */
  updatedAt: string;
}

export interface FlavorAuthor {
  name: string;
  url?: string;
  email?: string;
  /** Public key fingerprint, if the flavor was signed at publish time. */
  fingerprint?: string;
}

/**
 * Snapshot of a flavor at a point in time. Used by the auto-snapshot
 * recovery flow (§05.9) and three-way merge ancestor resolution.
 */
export interface FlavorSnapshot {
  /** Sequence number assigned by the storage layer. */
  seq: number;
  /** ISO timestamp of the snapshot. */
  capturedAt: string;
  /** The flavor at that point — deep-cloned, immutable. */
  flavor: Flavor;
  /** Optional one-line reason for the snapshot. */
  reason?: string;
}
