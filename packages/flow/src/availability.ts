/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a node can run is derived from what the host offers, not declared
 * as `browser-only` / `server-only`. The same report drives the editor's
 * greyed-out nodes and `ifc-lite flow validate`.
 */

import type { FlowDocument } from './document.js';
import type { NodeDef, NodeRegistry } from './registry.js';
import { referencedSecrets } from './secret-refs.js';

export interface HostFeatures {
  /** Backend feature names the host implements: `viewer`, `selection`, `visibility`, `files`, `store`, ... */
  readonly backend: ReadonlySet<string>;
  /** Whether a `network.fetch` bridge is configured. */
  readonly network: boolean;
  /** Secret names resolvable on this host (CLI/MCP env; never the browser). */
  readonly secrets: ReadonlySet<string>;
}

export type AvailabilityStatus = 'ok' | 'noop' | 'unavailable' | 'unknown';

export interface NodeAvailability {
  readonly nodeId: string;
  readonly type: string;
  readonly status: AvailabilityStatus;
  readonly reasons: readonly string[];
}

export function nodeAvailability(def: NodeDef<unknown> | undefined, type: string, features: HostFeatures): { status: AvailabilityStatus; reasons: string[] } {
  if (!def) return { status: 'unknown', reasons: [`unknown node type "${type}"`] };
  const reasons: string[] = [];
  const req = def.requires;
  let backendMissing = false;
  for (const f of req?.backend ?? []) {
    if (!features.backend.has(f)) {
      backendMissing = true;
      reasons.push(`backend feature "${f}" is not available on this host`);
    }
  }
  if (req?.network && !features.network) reasons.push('no network bridge on this host');
  for (const s of req?.secrets ?? []) {
    if (!features.secrets.has(s)) reasons.push(`secret "${s}" is not available on this host`);
  }
  if (reasons.length === 0) return { status: 'ok', reasons };
  // Only a missing backend feature can be a no-op (a viewer colorize with no
  // viewer); a missing secret or network is a real inability.
  const onlyBackend = backendMissing && reasons.length === (req?.backend ?? []).filter((f) => !features.backend.has(f)).length;
  if (onlyBackend && def.headless === 'noop') return { status: 'noop', reasons };
  return { status: 'unavailable', reasons };
}

export function checkAvailability(doc: FlowDocument, registry: NodeRegistry<unknown>, features: HostFeatures): NodeAvailability[] {
  // A `{{secret:NAME}}` in a node's params is a requirement of THAT node
  // instance, not of its type, so it is checked here rather than through
  // `def.requires`. Missing, it is a real inability, never a no-op.
  //
  // A reference must also be DECLARED (`secret.read:<NAME>`, always a literal
  // name) to be usable: the run refuses an undeclared one, so validation must
  // too, even when the host happens to have the variable set (#5446 review).
  const missingSecrets = new Map<string, Set<string>>();
  const declared = new Set(doc.capabilities);
  for (const ref of referencedSecrets(doc)) {
    const reason = !declared.has(`secret.read:${ref.name}`)
      ? `secret "${ref.name}" is referenced but the graph does not declare secret.read:${ref.name}`
      : !features.secrets.has(ref.name)
        ? `secret "${ref.name}" is not available on this host`
        : null;
    if (reason === null) continue;
    const reasons = missingSecrets.get(ref.nodeId) ?? new Set<string>();
    reasons.add(reason);
    missingSecrets.set(ref.nodeId, reasons);
  }
  return doc.nodes.map((n) => {
    const { status, reasons } = nodeAvailability(registry.get(n.type), n.type, features);
    const secretReasons = [...(missingSecrets.get(n.id) ?? [])];
    if (secretReasons.length === 0 || status === 'unknown') return { nodeId: n.id, type: n.type, status, reasons };
    return { nodeId: n.id, type: n.type, status: 'unavailable', reasons: [...reasons, ...secretReasons] };
  });
}
