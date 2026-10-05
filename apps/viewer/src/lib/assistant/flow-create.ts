/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `flow.create`: a typed new-graph proposal (#6919). The envelope is parsed
 * strictly, every node/param/port is checked against the native registry and
 * the result goes through the same document, wiring, grant and cycle checks
 * as a patch. Applying it always saves a NEW graph through the native
 * library (`importFlow`) and opens it; it never replaces an existing one and
 * never runs it.
 */

import { checkAvailability, digest, topologicalOrder, type FlowDocument, type FlowEdge, type FlowNode, type FlowOutput } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { BrowserTrackingStore, newFlowDocument } from '../flow/persistence';
import { flowRegistry, viewerFlowFeatures } from '../flow/runner';
import { requiredCapabilities } from '../flow/editor-ops';
import type { EvidenceSnapshot } from './evidence';
import { parseFlowCreate, type FlowCreateRequest } from './flow-create-envelope';
import { isNativeParamValue, validateProposedGraph } from './flow-validate';
import { trackingImpacts, type TrackingImpact } from './flow-tracking';

export interface FlowCreateProposal {
  readonly evidence: EvidenceSnapshot;
  readonly docJson: string;
  readonly capabilities: readonly string[];
  /** Nodes that write the model, with the native write kind. */
  readonly writers: readonly string[];
  /** Tracked nodes and the keys their elements will be owned under. */
  readonly tracking: readonly TrackingImpact[];
  /** Nodes this viewer host cannot run, with native reasons; the graph is still valid for other hosts. */
  readonly unavailable: readonly string[];
  /** Node ids in native execution order. */
  readonly order: readonly string[];
  readonly digest: string;
}
export interface FlowCreateReceipt { readonly proposal: FlowCreateProposal; readonly flowId: string; readonly created: FlowDocument }

/** Registry-checked native document; positions default to columns by execution depth. */
export function buildCreatedFlow(request: FlowCreateRequest): FlowDocument {
  const registry = flowRegistry();
  const ids = new Set<string>();
  const nodes: FlowNode[] = request.nodes.map(node => {
    if (ids.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
    const definition = registry.get(node.type);
    if (!definition) throw new Error(`Unknown node type: ${node.type}`);
    for (const [name, value] of Object.entries(node.params ?? {})) {
      const param = definition.params.find(p => p.name === name);
      if (!param) throw new Error(`Unknown native parameter: ${node.id}.${name}`);
      if (!isNativeParamValue(param, value)) throw new Error(`Invalid ${param.kind} parameter: ${node.id}.${name}`);
    }
    return { id: node.id, type: node.type, ...(node.params && Object.keys(node.params).length ? { params: node.params } : {}),
      ...(node.label ? { label: node.label } : {}), ...(node.lacing ? { lacing: node.lacing } : {}),
      ...(node.tracking ? { tracking: node.tracking } : {}), ...(node.trackingKey ? { trackingKey: node.trackingKey } : {}),
      ...(node.pos ? { pos: node.pos } : {}) };
  });
  const edges: FlowEdge[] = request.edges.map(edge => ({ from: edge.from, to: edge.to }));
  const outputs: FlowOutput[] = (request.outputs ?? []).map(output => ({ ...output }));
  const draft = newFlowDocument(request.name.trim());
  let doc: FlowDocument = { ...draft, ...(request.description?.trim() ? { description: request.description.trim() } : {}), nodes, edges, outputs };
  doc = { ...doc, capabilities: requiredCapabilities(doc, registry) };
  validateProposedGraph(doc);
  const depth = new Map<string, number>();
  for (const id of topologicalOrder(doc)) {
    depth.set(id, Math.max(0, ...doc.edges.filter(e => e.to[0] === id).map(e => (depth.get(e.from[0]) ?? 0) + 1)));
  }
  const rows = new Map<number, number>();
  return { ...doc, nodes: doc.nodes.map(node => {
    if (node.pos) return node;
    const column = depth.get(node.id) ?? 0, row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { ...node, pos: [column * 260, row * 140] as const };
  }) };
}

function createDigest(proposal: Omit<FlowCreateProposal, 'digest'>): string {
  return digest({ evidenceId: proposal.evidence.id, doc: proposal.docJson, capabilities: JSON.stringify(proposal.capabilities),
    writers: JSON.stringify(proposal.writers), tracking: JSON.stringify(proposal.tracking), unavailable: JSON.stringify(proposal.unavailable) });
}

export function prepareFlowCreateProposal(input: string, evidence: EvidenceSnapshot): FlowCreateProposal {
  if (evidence.source !== 'flow') throw new Error('Flow create proposals need Flow evidence');
  const doc = buildCreatedFlow(parseFlowCreate(input)), registry = flowRegistry();
  const proposal = { evidence, docJson: JSON.stringify(doc), capabilities: doc.capabilities,
    writers: doc.nodes.filter(node => registry.get(node.type)?.writes).map(node => `${node.id} (${node.type})`),
    tracking: trackingImpacts(null, doc),
    unavailable: checkAvailability(doc, registry, viewerFlowFeatures(true)).filter(n => n.status === 'unknown' || n.status === 'unavailable')
      .map(n => `${n.nodeId}: ${n.reasons.join(', ')}`),
    order: topologicalOrder(doc) };
  return { ...proposal, digest: createDigest(proposal) };
}

export type FlowCreateBlocker = 'running' | 'unsaved';
const BLOCKER_MESSAGE: Record<FlowCreateBlocker, string> = {
  running: 'A workflow is running; wait or cancel it first',
  unsaved: 'Save or discard the open graph before opening a new one',
};

/** Why another graph cannot be opened now, or `null`. */
export function flowCreateBlocker(): FlowCreateBlocker | null {
  const state = useViewerStore.getState();
  if (state.flowRunning) return 'running';
  if (state.flowDoc && state.activeFlowId && state.flowDirty) return 'unsaved';
  return null;
}
function assertCanOpen(): void {
  const blocker = flowCreateBlocker();
  if (blocker) throw new Error(BLOCKER_MESSAGE[blocker]);
}

/** Opens a graph this review created, under the same guard as creating it. */
export function openCreatedFlow(receipt: FlowCreateReceipt): void {
  if (useViewerStore.getState().activeFlowId === receipt.flowId) return;
  assertCanOpen();
  useViewerStore.getState().openFlow(receipt.flowId);
}

/** Saves the reviewed graph as a new library entry and opens it. Nothing runs. */
export function applyFlowCreateProposal(proposal: FlowCreateProposal, reviewedDigest: string): FlowCreateReceipt {
  if (reviewedDigest !== proposal.digest || createDigest(proposal) !== reviewedDigest) throw new Error('Reviewed proposal has changed');
  assertCanOpen();
  const doc: FlowDocument = JSON.parse(proposal.docJson);
  validateProposedGraph(doc);
  const state = useViewerStore.getState();
  // A fresh identity: a graph is never written over an existing library entry or tracking sidecar.
  const fresh: FlowDocument = { ...doc, id: crypto.randomUUID() };
  const flowId = state.importFlow(fresh);
  if (!flowId) throw new Error(useViewerStore.getState().flowStorageError ?? 'The workflow library is full');
  return { proposal, flowId, created: useViewerStore.getState().flowDoc ?? fresh };
}

/** Removal is offered only while the created graph is unchanged and has never recorded owned elements. */
export function canRemoveCreatedFlow(receipt: FlowCreateReceipt): boolean {
  const state = useViewerStore.getState();
  const saved = state.savedFlows.find(flow => flow.doc.id === receipt.flowId);
  const openEdited = state.activeFlowId === receipt.flowId && (state.flowDirty || state.flowDoc !== saved?.doc);
  return !!saved && saved.doc === receipt.created && !openEdited && !state.flowRunning && !BrowserTrackingStore.read(receipt.flowId);
}

export function removeCreatedFlow(receipt: FlowCreateReceipt): void {
  if (!canRemoveCreatedFlow(receipt)) throw new Error('The created graph was edited or run; delete it from Flow instead');
  useViewerStore.getState().deleteFlow(receipt.flowId);
}
