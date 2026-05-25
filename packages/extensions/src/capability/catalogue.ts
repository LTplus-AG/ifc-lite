/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Catalogue of known capabilities — the public-facing list of authority
 * scopes an extension may declare.
 *
 * Each entry has a stable `pattern` (matched against a parsed capability's
 * scope+action) plus a plain-English `description`. The review screen and
 * AI authoring prompt both consume this list.
 *
 * Adding entries here is part of the public API and follows manifest
 * SemVer.
 *
 * Spec: docs/architecture/ai-customization/02-security.md §3.1.
 */

import type { Capability, CapabilityScope, RiskTier } from '../types.js';

/** A registered capability template. */
export interface CapabilityCatalogueEntry {
  scope: CapabilityScope;
  action: string;
  /** True if a target is required (`network.fetch` etc.). */
  requiresTarget: boolean;
  /** Plain-English description shown to the user. */
  description: string;
  /** Default risk if the user does not narrow the target. */
  baseRisk: RiskTier;
}

const ENTRIES: CapabilityCatalogueEntry[] = [
  // ----- model
  { scope: 'model', action: 'read', requiresTarget: false, description: 'Read entities, properties, and geometry from loaded models.', baseRisk: 'green' },
  { scope: 'model', action: 'mutate', requiresTarget: true, description: 'Modify properties matching the listed pattern.', baseRisk: 'yellow' },
  { scope: 'model', action: 'create', requiresTarget: false, description: 'Create new entities in loaded models.', baseRisk: 'yellow' },
  { scope: 'model', action: 'delete', requiresTarget: false, description: 'Delete entities from loaded models.', baseRisk: 'red' },

  // ----- viewer
  { scope: 'viewer', action: 'read', requiresTarget: false, description: 'Read selection, camera, and current section state.', baseRisk: 'green' },
  { scope: 'viewer', action: 'colorize', requiresTarget: false, description: 'Apply colors / lens results to the viewport.', baseRisk: 'green' },
  { scope: 'viewer', action: 'isolate', requiresTarget: false, description: 'Hide and show entities in the viewport.', baseRisk: 'green' },
  { scope: 'viewer', action: 'fly', requiresTarget: false, description: 'Move the viewport camera.', baseRisk: 'green' },
  { scope: 'viewer', action: 'section', requiresTarget: false, description: 'Modify section planes.', baseRisk: 'green' },

  // ----- export
  { scope: 'export', action: 'create', requiresTarget: true, description: 'Produce a downloadable file in the named format.', baseRisk: 'yellow' },

  // ----- storage
  { scope: 'storage', action: 'local', requiresTarget: false, description: 'Read and write per-extension local storage.', baseRisk: 'green' },

  // ----- network
  { scope: 'network', action: 'fetch', requiresTarget: true, description: 'Fetch from URLs matching the listed host pattern.', baseRisk: 'red' },

  // ----- command
  { scope: 'command', action: 'invoke', requiresTarget: true, description: 'Invoke other extensions\' commands matching the listed id pattern.', baseRisk: 'yellow' },

  // ----- ui (implicit when contributing; declarable for clarity)
  { scope: 'ui', action: 'dock', requiresTarget: false, description: 'Contribute panels to the dock slots.', baseRisk: 'green' },
  { scope: 'ui', action: 'toolbar', requiresTarget: false, description: 'Contribute buttons to the toolbar.', baseRisk: 'green' },
  { scope: 'ui', action: 'contextMenu', requiresTarget: false, description: 'Contribute items to context menus.', baseRisk: 'green' },
  { scope: 'ui', action: 'statusBar', requiresTarget: false, description: 'Contribute items to the status bar.', baseRisk: 'green' },
];

const BY_KEY = new Map<string, CapabilityCatalogueEntry>(
  ENTRIES.map((e) => [`${e.scope}.${e.action}`, e]),
);

/** All known catalogue entries, in declaration order. */
export function listCapabilityCatalogue(): readonly CapabilityCatalogueEntry[] {
  return ENTRIES;
}

/** Find the catalogue entry matching a parsed capability. */
export function findCatalogueEntry(cap: Capability): CapabilityCatalogueEntry | undefined {
  return BY_KEY.get(`${cap.scope}.${cap.action}`);
}

/** Returns true if the capability appears in the catalogue. */
export function isKnownCapability(cap: Capability): boolean {
  return BY_KEY.has(`${cap.scope}.${cap.action}`);
}
