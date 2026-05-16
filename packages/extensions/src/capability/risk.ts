/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Risk-badge computation.
 *
 * Translates a parsed capability into a tier (`green` | `yellow` | `red`)
 * and a plain-English description. Used by the review screen and AI
 * authoring critic.
 *
 * Escalation rules (mirroring 02-security.md §4):
 *   - Universal wildcard targets escalate to red.
 *   - `network.fetch` is always red unless the target is a single
 *     specific host (no wildcard segments), in which case it stays at
 *     its catalogue base (still yellow → we surface it).
 *   - `model.mutate:*` (universal wildcard) escalates to red even though
 *     the catalogue base is yellow.
 *   - Unknown capabilities default to red so we never under-warn.
 */

import type { Capability, CapabilityRisk, CapabilityTarget, RiskTier } from '../types.js';
import { findCatalogueEntry } from './catalogue.js';

export function computeRisk(cap: Capability): CapabilityRisk {
  const entry = findCatalogueEntry(cap);

  if (!entry) {
    return {
      capability: cap,
      tier: 'red',
      description: `Unknown capability "${cap.raw}". Treated as high-risk because it is not in the catalogue.`,
    };
  }

  // Required-target check.
  if (entry.requiresTarget && !cap.target) {
    return {
      capability: cap,
      tier: 'red',
      description: `${entry.description} (Missing required target — treated as universal.)`,
    };
  }

  let tier: RiskTier = entry.baseRisk;
  let suffix = '';

  // Universal wildcard escalates everything sensitive.
  if (cap.target?.isUniversalWildcard) {
    if (entry.baseRisk !== 'green') {
      tier = 'red';
      suffix = ' Universal wildcard target — unrestricted scope.';
    }
  } else if (cap.target && hasInternalGlob(cap.target)) {
    // Glob inside (not universal) — bump green→yellow at most, leave others.
    if (entry.baseRisk === 'green') tier = 'yellow';
  }

  // network.fetch with a specific single host stays yellow (we surface
  // the host explicitly in description); with wildcards it's already red.
  if (cap.scope === 'network' && cap.action === 'fetch') {
    if (cap.target?.isUniversalWildcard) {
      tier = 'red';
    } else if (cap.target && hasInternalGlob(cap.target)) {
      tier = 'red';
      suffix = ' Host pattern contains a wildcard.';
    } else {
      tier = 'yellow';
    }
  }

  // model.delete is always red (catalogue base) but if it ever has a target
  // limit it doesn't get safer.
  if (cap.scope === 'model' && cap.action === 'delete') {
    tier = 'red';
  }

  const description = composeDescription(cap, entry.description, suffix);
  return { capability: cap, tier, description };
}

export function computeRisks(caps: readonly Capability[]): CapabilityRisk[] {
  return caps.map(computeRisk);
}

/** Highest tier across a list of risks. Returns 'green' for the empty list. */
export function overallTier(risks: readonly CapabilityRisk[]): RiskTier {
  let highest: RiskTier = 'green';
  for (const r of risks) {
    if (r.tier === 'red') return 'red';
    if (r.tier === 'yellow') highest = 'yellow';
  }
  return highest;
}

function hasInternalGlob(target: CapabilityTarget): boolean {
  if (target.isUniversalWildcard) return true;
  for (const seg of target.segments) {
    if (seg.kind === 'glob') return true;
    if (seg.kind === 'literal' && seg.value.endsWith('*')) return true;
  }
  return false;
}

function composeDescription(cap: Capability, base: string, suffix: string): string {
  if (!cap.target) return `${base}${suffix}`;
  return `${base} Target: \`${cap.target.raw}\`.${suffix}`;
}
