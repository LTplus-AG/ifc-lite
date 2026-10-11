/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Suppressions (`StudioMeta.suppressions`, keyed by node id).
 *
 * A suppression attached to a node silences a rule on that node and on
 * every node below it (constraint → facet → specification → document).
 * `rule` is a full code (`IDSL-SPEC-008`) or an area wildcard
 * (`IDSL-SPEC-*`). A suppression must carry a non-empty `reason`; one
 * without a reason is ignored, so the finding stays visible.
 */

import { locateNode } from '../document/node-index.js';
import type { StudioDocument, Suppression } from '../document/types.js';
import type { Uuid } from '../uuid.js';
import type { Diagnostic, SuppressedDiagnostic } from './types.js';

/** The node and its ancestors, most specific first. */
export function ancestry(doc: StudioDocument, nodeId: Uuid): Uuid[] {
  const loc = locateNode(doc, nodeId);
  const chain = [nodeId];
  if (loc && loc.kind === 'constraint') chain.push(loc.facetId, loc.specId);
  else if (loc && (loc.kind === 'applicabilityFacet' || loc.kind === 'requirement')) chain.push(loc.specId);
  if (nodeId !== doc.nodes.document) chain.push(doc.nodes.document);
  return chain;
}

export function suppressionMatches(s: Suppression, code: string): boolean {
  if (s.reason.trim() === '') return false;
  if (s.rule === code) return true;
  return s.rule.endsWith('*') && code.startsWith(s.rule.slice(0, -1));
}

/** Split diagnostics into active and suppressed ones. */
export function applySuppressions(
  doc: StudioDocument,
  diagnostics: readonly Diagnostic[],
): { active: Diagnostic[]; suppressed: SuppressedDiagnostic[] } {
  const all = doc.meta.suppressions;
  const active: Diagnostic[] = [];
  const suppressed: SuppressedDiagnostic[] = [];
  if (Object.keys(all).length === 0) return { active: [...diagnostics], suppressed };
  for (const d of diagnostics) {
    let hit: SuppressedDiagnostic | undefined;
    for (const nodeId of ancestry(doc, d.nodeId)) {
      const s = (all[nodeId] ?? []).find((x) => suppressionMatches(x, d.code));
      if (s) {
        hit = { diagnostic: d, suppressedAt: nodeId, suppression: s };
        break;
      }
    }
    if (hit) suppressed.push(hit);
    else active.push(d);
  }
  return { active, suppressed };
}
