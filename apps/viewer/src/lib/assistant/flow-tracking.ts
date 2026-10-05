/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a proposed graph edit means for elements the graph owns (#6919).
 *
 * A tracked node (`NodeDef.tracked`, e.g. `model.addElement`) owns the
 * elements it created under its tracking key (`trackingKeyOf`: the explicit
 * key, else `<graph name>/<label or id>`). The native scheduler then:
 *  - updates or keeps those elements when the node's branch changes;
 *  - removes them in the orphan sweep when the node is deleted or its key
 *    changes (also by renaming the graph or the node's label while no
 *    explicit key is set), and creates new elements under the new key;
 *  - follows the node's tracking mode (`replace` makes fresh elements each run).
 * Counts come from the graph's native tracking sidecar for the active model.
 */

import { trackingKeyOf, type FlowDocument, type FlowNode, type TrackingMode } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { BrowserTrackingStore } from '../flow/persistence';
import { flowRegistry } from '../flow/runner';
import { withUpstream } from '../flow/upstream';

export type TrackingEffect = 'removed' | 'rekeyed' | 'mode' | 'branch' | 'added';
export interface TrackingImpact {
  readonly nodeId: string;
  readonly effect: TrackingEffect;
  readonly trackingKey: string;
  readonly nextTrackingKey?: string;
  readonly mode?: TrackingMode;
  /** Elements recorded for this key on the active model; `null` when no run was recorded for it. */
  readonly ownedElements: number | null;
}

/** The same pin the Flow runner gives `BrowserTrackingStore`. */
export function activeTrackingPin(): string | null {
  const { activeModelId, models } = useViewerStore.getState();
  if (!activeModelId) return null;
  const hash = models.get(activeModelId)?.sourceContentHash;
  return hash ? `content:${hash}` : `model:${activeModelId}`;
}

/** What the scheduler sees of a branch: node types, params, lacing, tracking and wiring; not positions or labels. */
function branchSignature(doc: FlowDocument, nodeId: string): string {
  const ids = withUpstream(doc, [nodeId]);
  const nodes = doc.nodes.filter(node => ids.has(node.id)).map(({ id, type, params, lacing, tracking, trackingKey }) =>
    ({ id, type, params, lacing, tracking, trackingKey })).sort((a, b) => a.id.localeCompare(b.id));
  const edges = doc.edges.filter(edge => ids.has(edge.to[0])).map(edge => `${edge.from.join('.')}>${edge.to.join('.')}`).sort();
  return JSON.stringify({ nodes, edges });
}

/** Every tracked node a change from `before` to `after` affects, with the elements it owns now. */
export function trackingImpacts(before: FlowDocument | null, after: FlowDocument): TrackingImpact[] {
  const registry = flowRegistry();
  const tracked = (node: FlowNode) => registry.get(node.type)?.tracked === true;
  const pin = activeTrackingPin();
  const sidecar = before ? BrowserTrackingStore.read(before.id) : undefined;
  const owned = (key: string) => sidecar && pin && sidecar.pinnedTo === pin && sidecar.sets[key]
    ? Object.keys(sidecar.sets[key].entries).length : null;
  const impacts: TrackingImpact[] = [];
  const afterNodes = new Map(after.nodes.map(node => [node.id, node]));
  for (const node of before?.nodes.filter(tracked) ?? []) {
    const trackingKey = trackingKeyOf(before!, node);
    const next = afterNodes.get(node.id);
    const base = { nodeId: node.id, trackingKey, ownedElements: owned(trackingKey) };
    if (!next || !tracked(next)) { impacts.push({ ...base, effect: 'removed' }); continue; }
    const nextTrackingKey = trackingKeyOf(after, next);
    if (nextTrackingKey !== trackingKey) impacts.push({ ...base, effect: 'rekeyed', nextTrackingKey });
    else if ((next.tracking ?? 'update') !== (node.tracking ?? 'update')) impacts.push({ ...base, effect: 'mode', mode: next.tracking ?? 'update' });
    else if (branchSignature(before!, node.id) !== branchSignature(after, node.id)) impacts.push({ ...base, effect: 'branch' });
  }
  const existing = new Set(before?.nodes.filter(tracked).map(node => node.id));
  for (const node of after.nodes.filter(tracked)) if (!existing.has(node.id)) {
    impacts.push({ nodeId: node.id, effect: 'added', trackingKey: trackingKeyOf(after, node), ownedElements: null });
  }
  return impacts;
}
