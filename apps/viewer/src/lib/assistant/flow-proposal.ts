/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { digest, type FlowDocument } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { isContributedFlowId } from '@/services/extensions/host-flows';
import { flowRegistry } from '../flow/runner';
import { addNode, removeNode, moveNode, setParam, updateNode, connect, disconnect, requiredCapabilities } from '../flow/editor-ops';
import { evidenceIsCurrent, type EvidenceSnapshot } from './evidence';
import { isFlowSource } from './sources';
import { parseFlowPatch, isBoundedFlowJson, type FlowPatch } from './flow-patch';
import { changedCodeParams, isNativeParamValue, validateProposedGraph, type FlowCodeParam } from './flow-validate';
import { trackingImpacts, trackingStateDigest, type TrackingImpact } from './flow-tracking';
import { flowRunDiagnostics, isFailingNode } from './flow-run-evidence';
import { pinnedFlowRun } from './adapters/flow-run';
import { withUpstream } from '../flow/upstream';

/** A debug patch's cited nodes with the native run's own error text, never the model's. */
export interface FlowProposalDiagnosis {
  readonly explanation: string;
  readonly nodes: ReadonlyArray<{ nodeId: string; status: string; laneErrors: number; messages: readonly string[] }>;
}

export interface FlowProposal {
  readonly evidence: EvidenceSnapshot;
  readonly target: FlowDocument;
  readonly activeFlowId: string | null;
  readonly patchJson: string;
  readonly beforeJson: string;
  readonly afterJson: string;
  readonly addedCapabilities: readonly string[];
  /** Tracked nodes this edit affects; non-empty requires explicit acknowledgement before apply. */
  readonly tracking: readonly TrackingImpact[];
  /** `trackingStateDigest` at review: the owned elements themselves, not only their counts, must be unchanged to apply. */
  readonly trackingState: string;
  readonly diagnosis: FlowProposalDiagnosis | null;
  /** Script source this patch writes, listed verbatim in review. */
  readonly code: readonly FlowCodeParam[];
  readonly digest: string;
}
export interface FlowApplyReceipt { readonly proposal: FlowProposal; readonly applied: FlowDocument }

function editable(doc: FlowDocument): boolean {
  const state = useViewerStore.getState();
  return !state.flowRunning && state.flowDoc === doc
    && !(state.activeFlowId === null && isContributedFlowId(doc.id));
}
function applyOperations(before: FlowDocument, patch: FlowPatch): FlowDocument {
  const registry = flowRegistry();
  let doc = structuredClone(before);
  const aliases = new Map<string, string>();
  const resolve = (id: string) => {
    const resolved = aliases.get(id) ?? id;
    if (!doc.nodes.some(node => node.id === resolved)) throw new Error(`Unknown graph node: ${id}`);
    return resolved;
  };
  for (const operation of patch.operations) {
    if (operation.op === 'addNode') {
      if (!registry.get(operation.type)) throw new Error(`Unknown node type: ${operation.type}`);
      if (aliases.has(operation.alias) || doc.nodes.some(node => node.id === operation.alias)) throw new Error('New node alias conflicts with an existing identity');
      const added = addNode(doc, operation.type, operation.pos);
      if (aliases.has(added.nodeId) && added.nodeId !== operation.alias) throw new Error('Generated node identity conflicts with a proposal alias');
      doc = added.doc; aliases.set(operation.alias, added.nodeId);
    } else if (operation.op === 'removeNode') doc = removeNode(doc, resolve(operation.node));
    else if (operation.op === 'moveNode') doc = moveNode(doc, resolve(operation.node), operation.pos);
    else if (operation.op === 'updateNode') doc = updateNode(doc, resolve(operation.node), operation.patch);
    else if (operation.op === 'setParam' || operation.op === 'unsetParam') {
      const id = resolve(operation.node), node = doc.nodes.find(n => n.id === id)!;
      const definition = registry.get(node.type)?.params.find(p => p.name === operation.param);
      if (!definition) throw new Error(`Unknown native parameter: ${operation.param}`);
      if (operation.op === 'setParam') {
        if (!isNativeParamValue(definition, operation.value)) throw new Error(`Invalid ${definition.kind} parameter: ${operation.param}`);
      }
      doc = setParam(doc, id, operation.param, operation.op === 'setParam' ? operation.value : undefined);
    } else if (operation.op === 'connect') {
      const result = connect(doc, registry, { from: [resolve(operation.from[0]), operation.from[1]], to: [resolve(operation.to[0]), operation.to[1]] });
      if (result.error) throw new Error(result.error);
      doc = result.doc;
    } else if (operation.op === 'disconnect') {
      const id = resolve(operation.to[0]);
      if (!registry.get(doc.nodes.find(n => n.id === id)!.type)?.inputs.some(p => p.name === operation.to[1])) throw new Error('Unknown native input port');
      doc = disconnect(doc, id, operation.to[1]);
    } else doc = { ...doc, name: operation.name };
  }
  // Grants are part of the visible reviewed effect, never an invisible run-time expansion.
  doc = { ...doc, capabilities: [...new Set([...doc.capabilities, ...requiredCapabilities(doc, registry)])] };
  validateProposedGraph(doc);
  return doc;
}
function proposalDigest(proposal: Omit<FlowProposal, 'digest'>): string {
  // Native digest over bounded strings avoids recursively walking file-supplied params.
  return digest({ evidenceId: proposal.evidence.id, evidencePayload: proposal.evidence.payload,
    graphId: proposal.target.id, activeFlowId: proposal.activeFlowId,
    patch: proposal.patchJson, before: proposal.beforeJson, after: proposal.afterJson,
    addedCapabilities: JSON.stringify(proposal.addedCapabilities), tracking: JSON.stringify(proposal.tracking), trackingState: proposal.trackingState,
    diagnosis: JSON.stringify(proposal.diagnosis), code: JSON.stringify(proposal.code) });
}

/** Nodes whose evaluation an operation changes; positions, labels and the graph name change none. */
function behaviourTargets(patch: FlowPatch): string[] {
  return patch.operations.flatMap(op => op.op === 'connect' ? [op.from[0], op.to[0]] : op.op === 'disconnect' ? [op.to[0]]
    : op.op === 'setParam' || op.op === 'unsetParam' || op.op === 'removeNode' ? [op.node]
      : op.op === 'updateNode' && Object.keys(op.patch).some(key => key !== 'label') ? [op.node] : []);
}

/** Cited nodes must have failed in the captured run, and the fix must change their branch's behaviour. */
function diagnose(patch: FlowPatch, before: FlowDocument, evidence: EvidenceSnapshot): FlowProposalDiagnosis | null {
  if (!patch.diagnosis) return null;
  // Only `flowRun` evidence pins a run; graph-structure (`flow`) evidence cannot support a diagnosis.
  const pin = pinnedFlowRun(evidence);
  const run = pin ? flowRunDiagnostics({ ...useViewerStore.getState(), flowLastRun: pin.run, flowLastError: pin.error, flowLastRunWindow: pin.window }) : null;
  if (!run || run.verdict === 'not-run') throw new Error('Debug proposals need a captured Flow run');
  const nodes = patch.diagnosis.nodes.map(nodeId => {
    const node = run.nodes.find(candidate => candidate.nodeId === nodeId);
    if (!node || !isFailingNode(node)) throw new Error(`Diagnosis cites ${nodeId}, which did not fail in the captured run`);
    return { nodeId, status: node.status, laneErrors: node.laneErrors, messages: [...node.error ? [node.error] : [], ...node.errorMessages].slice(0, 5) };
  });
  const branch = withUpstream(before, nodes.map(node => node.nodeId));
  if (!behaviourTargets(patch).some(id => branch.has(id))) throw new Error('Debug patch does not change the failing nodes or their inputs');
  return { explanation: patch.diagnosis.explanation.trim(), nodes };
}

export function prepareFlowProposal(text: string, evidence: EvidenceSnapshot): FlowProposal {
  if (!isFlowSource(evidence.source) || !evidenceIsCurrent(evidence)) throw new Error('Flow evidence is stale');
  const state = useViewerStore.getState(), before = state.flowDoc;
  if (!before || !editable(before)) throw new Error('Graph is running or read-only');
  if (!isBoundedFlowJson(before)) throw new Error('Graph exceeds the proposal review limits');
  const patch = parseFlowPatch(text), after = applyOperations(before, patch);
  const proposal = { evidence, target: before, activeFlowId: state.activeFlowId,
    patchJson: JSON.stringify(patch), beforeJson: JSON.stringify(before), afterJson: JSON.stringify(after),
    addedCapabilities: after.capabilities.filter(cap => !before.capabilities.includes(cap)),
    tracking: trackingImpacts(before, after), trackingState: trackingStateDigest(before.id), diagnosis: diagnose(patch, before, evidence), code: changedCodeParams(before, after) };
  return { ...proposal, digest: proposalDigest(proposal) };
}

export function isFlowProposalCurrent(proposal: FlowProposal): boolean {
  const state = useViewerStore.getState();
  return editable(proposal.target) && state.activeFlowId === proposal.activeFlowId && evidenceIsCurrent(proposal.evidence)
    && JSON.stringify(proposal.target) === proposal.beforeJson && trackingStateDigest(proposal.target.id) === proposal.trackingState;
}
export function isFlowReceiptCurrent(receipt: FlowApplyReceipt): boolean {
  const state = useViewerStore.getState();
  return editable(receipt.applied) && state.activeFlowId === receipt.proposal.activeFlowId
    // Applying cleared the run the evidence described; the graph itself is the identity now.
    && evidenceIsCurrent({ ...receipt.proposal.evidence, source: 'flow', sourceIdentity: receipt.applied, reportStamp: null })
    && JSON.stringify(receipt.applied) === receipt.proposal.afterJson
    && JSON.stringify(receipt.proposal.target) === receipt.proposal.beforeJson;
}

/** Review commits only the graph. Model edits, network and execution need a later Run. */
export function applyFlowProposal(proposal: FlowProposal, reviewedDigest: string, options: { trackingAcknowledged?: boolean } = {}): FlowApplyReceipt {
  const state = useViewerStore.getState();
  if (reviewedDigest !== proposal.digest || proposalDigest(proposal) !== reviewedDigest) throw new Error('Reviewed proposal has changed');
  if (proposal.tracking.length && options.trackingAcknowledged !== true) throw new Error('Tracked element effects must be acknowledged before applying');
  if (!isFlowProposalCurrent(proposal)) throw new Error('Graph or evidence changed after review');
  const candidate = applyOperations(proposal.target, parseFlowPatch(proposal.patchJson));
  if (JSON.stringify(candidate) !== proposal.afterJson) throw new Error('Native preview no longer matches the reviewed changes');
  // Owned element counts are read from the sidecar; a run since review changes them.
  if (JSON.stringify(trackingImpacts(proposal.target, candidate)) !== JSON.stringify(proposal.tracking)) throw new Error('Tracked elements changed after review');
  // Synchronous native store boundary: no await can retarget the reviewed document.
  state.setFlowDoc(candidate);
  return { proposal, applied: candidate };
}

export function undoFlowProposal(receipt: FlowApplyReceipt): void {
  const state = useViewerStore.getState();
  if (!isFlowReceiptCurrent(receipt)) throw new Error('Graph changed after apply; graph undo was refused');
  state.setFlowDoc(receipt.proposal.target);
}
