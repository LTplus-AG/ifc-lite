/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Extension-contributed flow graphs (`contributes.flows`, #5167 phase 4.2).
 *
 * `packages/extensions` validates `contributes.flows` structurally only —
 * it does not depend on `@ifc-lite/flow`, so a contribution there is just
 * `{ id, name, path }` plus a cross-reference check that `path` exists in
 * the bundle (mirrors `contributes.exporters[].handler`). This module is
 * the viewer-side counterpart, the sibling of `host-exporters.ts`: it
 * reads the referenced `*.flow.json` file and validates it the same way a
 * user-authored graph is validated — `parseFlowDocument` (structural) and
 * `validateFlowWiring` (registry-aware). A graph that fails either check
 * is rejected with a diagnostic naming the extension and the graph; the
 * rest of the extension's contributions are unaffected, matching how an
 * exporter with a missing handler only fails when *that* exporter runs,
 * not the whole extension load.
 *
 * A graph's declared `capabilities` are bounded by the extension's
 * GRANTED capabilities (`record.grantedCapabilities`, the user-approved
 * subset from the install review screen) — not its merely-declared ones.
 * A graph that reaches further than the user actually approved is
 * rejected the same way a malformed graph is.
 *
 * Ids are namespaced `ext:<extensionId>:<contributionId>` so a
 * contributed graph can never collide with, or silently overwrite, a
 * user's own saved graph (saved-graph ids are `crypto.randomUUID()` and
 * never start with `ext:`). Uninstalling or disabling the extension drops
 * its record from `storage.listExtensions()`, so the next resolve simply
 * stops producing that extension's graphs — no separate cleanup needed.
 */

import {
  hasCapability,
  parseCapabilities,
  parseCapability,
  type ExtensionLoader,
  type InstalledExtensionRecord,
  normaliseBundlePath,
} from '@ifc-lite/extensions';
import { BrowserTrackingStore } from '@/lib/flow/persistence.js';
import { clearPlayerValuesByIdPrefix } from '@/lib/flow/player-values.js';
import { parseFlowDocument, validateFlowWiring, type FlowDocument, type NodeRegistry } from '@ifc-lite/flow';

/** Prefix that marks a flow document id as extension-owned, read-only. */
export const CONTRIBUTED_FLOW_PREFIX = 'ext:';

export function contributedFlowId(extensionId: string, graphId: string): string {
  return `${CONTRIBUTED_FLOW_PREFIX}${extensionId}:${graphId}`;
}

export function isContributedFlowId(id: string): boolean {
  return id.startsWith(CONTRIBUTED_FLOW_PREFIX);
}

/** A flow graph resolved from an installed extension's `contributes.flows`. */
export interface ContributedFlow {
  /** The document, with `id` rewritten to the namespaced id and `name` set from the contribution. */
  readonly doc: FlowDocument;
  readonly extensionId: string;
  readonly extensionName: string;
  /** The contribution's own (unnamespaced) id, for diagnostics and duplicate-source display. */
  readonly graphId: string;
}

export interface FlowContributionDiagnostic {
  readonly extensionId: string;
  readonly graphId: string;
  readonly message: string;
}

export interface ResolveFlowContributionsResult {
  readonly graphs: readonly ContributedFlow[];
  readonly diagnostics: readonly FlowContributionDiagnostic[];
}

interface ResolveFlowContributionsDeps {
  loader: Pick<ExtensionLoader, 'getBundle'>;
}

/**
 * Resolve every flow graph contributed by installed, enabled extensions
 * whose bundle is currently loaded (`loader.getBundle` returns something —
 * an extension that failed to load contributes nothing, same as it
 * contributes no commands or exporters).
 */
export function resolveFlowContributions(
  deps: ResolveFlowContributionsDeps,
  records: readonly InstalledExtensionRecord[],
  registry: NodeRegistry<unknown>,
): ResolveFlowContributionsResult {
  const graphs: ContributedFlow[] = [];
  const diagnostics: FlowContributionDiagnostic[] = [];

  for (const record of records) {
    if (!record.enabled) continue;
    const bundle = deps.loader.getBundle(record.id);
    if (!bundle) continue;
    const contributions = bundle.manifest.contributes?.flows ?? [];
    if (contributions.length === 0) continue;

    const grantsResult = parseCapabilities(record.grantedCapabilities);
    const grants = grantsResult.ok ? grantsResult.value : [];

    // Two contributions sharing an id would share one namespaced id, and the
    // panel finds a graph by id, so one of them could never be opened. Neither
    // is guessed at: every contribution with a repeated id is refused.
    const idCounts = new Map<string, number>();
    for (const contribution of contributions) idCounts.set(contribution.id, (idCounts.get(contribution.id) ?? 0) + 1);

    for (const contribution of contributions) {
      const fail = (message: string): void => {
        diagnostics.push({ extensionId: record.id, graphId: contribution.id, message });
      };

      if ((idCounts.get(contribution.id) ?? 0) > 1) {
        fail(`the id "${contribution.id}" is used by more than one flow contribution in this extension.`);
        continue;
      }

      const file = bundle.files.get(normaliseBundlePath(contribution.path));
      if (!file) {
        fail(`file "${contribution.path}" is missing from the bundle.`);
        continue;
      }

      let doc: FlowDocument;
      try {
        doc = parseFlowDocument(file.text ?? new TextDecoder().decode(file.bytes));
      } catch (err) {
        fail(`not a valid flow document: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const wiringProblems = validateFlowWiring(doc, registry);
      if (wiringProblems.length > 0) {
        fail(`wiring problems: ${wiringProblems.map((p) => `${p.path || '<root>'}: ${p.message}`).join('; ')}`);
        continue;
      }

      const exceeded = doc.capabilities.filter((raw) => {
        const parsed = parseCapability(raw);
        return !parsed.ok || !hasCapability(grants, parsed.value);
      });
      if (exceeded.length > 0) {
        fail(`declares capabilities the extension was not granted: ${exceeded.join(', ')}.`);
        continue;
      }

      graphs.push({
        doc: { ...doc, id: contributedFlowId(record.id, contribution.id), name: contribution.name },
        extensionId: record.id,
        extensionName: bundle.manifest.name,
        graphId: contribution.id,
      });
    }
  }

  return { graphs, diagnostics };
}

/**
 * Forget the per-graph state an uninstalled extension's contributed graphs
 * left behind (their tracking sidecars and last-used Player values), as
 * deleting a saved graph does: a reinstall must not inherit tracked elements
 * or form values from the removed one (#5431 review, #5634). Disabling keeps
 * both, so re-enabling still updates, not duplicates.
 */
export function forgetContributedFlowState(extensionId: string): void {
  const prefix = contributedFlowId(extensionId, '');
  BrowserTrackingStore.clearByIdPrefix(prefix);
  clearPlayerValuesByIdPrefix(prefix);
}
