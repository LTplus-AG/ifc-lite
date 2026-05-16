/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Filter mined patterns against the user's installed extensions.
 *
 * If the user already has a tool covering a pattern (saved scripts
 * promoted to extensions, AI-authored tools, etc.), the miner should
 * not re-suggest it. We compare the pattern against the inferred
 * "intent surface" of each installed extension, derived from its
 * declared capabilities.
 *
 * The filter is conservative — it errs toward filtering OUT
 * suggestions that look already-covered, rather than spamming the
 * user. Sharper matching (per-command, per-handler analysis) can
 * land later without changing the public API.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §3.2.
 */

import type { ActionIntent } from '../log/types.js';
import type { MinedPattern } from './types.js';

export interface InstalledExtensionSummary {
  id: string;
  grantedCapabilities: readonly string[];
}

/** Reverse map: capability → intents it implies. */
const CAPABILITY_TO_INTENTS: Record<string, readonly ActionIntent[]> = {
  'model.read': ['model.load', 'query.run'],
  'model.create': ['model.load'],
  'viewer.colorize': ['lens.apply'],
  'viewer.isolate': ['view.change'],
  'viewer.fly': ['view.change'],
  'viewer.section': ['section.apply'],
  'export.create:*': ['export.run'],
  'export.create:csv': ['export.run'],
  'export.create:json': ['export.run'],
  'export.create:glb': ['export.run'],
  'export.create:gltf': ['export.run'],
  'export.create:ifc': ['export.run'],
  'export.create:ifcx': ['export.run'],
  'export.create:parquet': ['export.run'],
};

/**
 * Drop patterns the user already has an extension covering. Returns a
 * fresh array (does not mutate).
 */
export function filterAgainstInstalled(
  patterns: readonly MinedPattern[],
  installed: readonly InstalledExtensionSummary[],
): MinedPattern[] {
  if (installed.length === 0) return [...patterns];
  const coveredSets = installed.map((ext) => coveredIntents(ext.grantedCapabilities));
  return patterns.filter((p) => {
    const intents = new Set(p.sequence);
    return !coveredSets.some((covered) => isSubset(intents, covered));
  });
}

function coveredIntents(capabilities: readonly string[]): Set<ActionIntent> {
  const set = new Set<ActionIntent>();
  for (const cap of capabilities) {
    // Try exact match first.
    const intents = CAPABILITY_TO_INTENTS[cap];
    if (intents) {
      for (const i of intents) set.add(i);
      continue;
    }
    // Fall through to prefix match for capability families
    // (e.g. `export.create:custom` → catch the `export.create:*` row).
    for (const [knownCap, knownIntents] of Object.entries(CAPABILITY_TO_INTENTS)) {
      if (knownCap.endsWith(':*') && cap.startsWith(knownCap.slice(0, -1))) {
        for (const i of knownIntents) set.add(i);
      }
    }
  }
  return set;
}

function isSubset<T>(small: Set<T>, big: Set<T>): boolean {
  for (const item of small) {
    if (!big.has(item)) return false;
  }
  return true;
}
