/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseCapabilities } from '@ifc-lite/extensions';
import { digest, validateFlowDocument, validateFlowWiring, topologicalOrder, type FlowDocument } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { isContributedFlowId } from '@/services/extensions/host-flows';
import { flowRegistry } from '../flow/runner';
import { addNode, removeNode, moveNode, setParam, updateNode, connect, disconnect, requiredCapabilities } from '../flow/editor-ops';
import { evidenceIsCurrent, type EvidenceSnapshot } from './evidence';
import { parseFlowPatch, isBoundedFlowJson, type FlowPatch } from './flow-patch';

export interface FlowProposal {
  readonly evidence: EvidenceSnapshot;
  readonly target: FlowDocument;
  readonly activeFlowId: string | null;
  readonly patchJson: string;
  readonly beforeJson: string;
  readonly afterJson: string;
  readonly addedCapabilities: readonly string[];
  readonly trackingChanged: boolean;
  readonly digest: string;
}
export interface FlowApplyReceipt { readonly proposal: FlowProposal; readonly applied: FlowDocument }

function editable(doc: FlowDocument): boolean {
  const state = useViewerStore.getState();
  return !state.flowRunning && state.flowDoc === doc
    && !(state.activeFlowId === null && isContributedFlowId(doc.id));
}
function validate(doc: FlowDocument): void {
  if (!isBoundedFlowJson(doc) || doc.nodes.length > 100 || doc.edges.length > 200 || JSON.stringify(doc).length > 500_000) {
    throw new Error('Graph exceeds the proposal review limits');
  }
  const problems = [...validateFlowDocument(doc), ...validateFlowWiring(doc, flowRegistry())];
  if (problems.length) throw new Error(problems.slice(0, 10).map(p => `${p.path}: ${p.message}`).join('\n'));
  const grants = parseCapabilities(doc.capabilities);
  if (!grants.ok) throw new Error(grants.errors.map(e => e.message).join('; '));
  topologicalOrder(doc);
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
        const value = operation.value;
        const valid = definition.kind === 'json' || (definition.kind === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : definition.kind === 'boolean' ? typeof value === 'boolean'
          : typeof value === 'string' && (definition.kind !== 'enum' || definition.options?.includes(value)));
        if (!valid) throw new Error(`Invalid ${definition.kind} parameter: ${operation.param}`);
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
  validate(doc);
  return doc;
}
function proposalDigest(proposal: Omit<FlowProposal, 'digest'>): string {
  // Native digest over bounded strings avoids recursively walking file-supplied params.
  return digest({ evidenceId: proposal.evidence.id, evidencePayload: proposal.evidence.payload,
    graphId: proposal.target.id, activeFlowId: proposal.activeFlowId,
    patch: proposal.patchJson, before: proposal.beforeJson, after: proposal.afterJson,
    addedCapabilities: JSON.stringify(proposal.addedCapabilities), trackingChanged: proposal.trackingChanged });
}

export function prepareFlowProposal(text: string, evidence: EvidenceSnapshot): FlowProposal {
  if (evidence.source !== 'flow' || !evidenceIsCurrent(evidence)) throw new Error('Flow evidence is stale');
  const state = useViewerStore.getState(), before = state.flowDoc;
  if (!before || !editable(before)) throw new Error('Graph is running or read-only');
  if (!isBoundedFlowJson(before)) throw new Error('Graph exceeds the proposal review limits');
  const patch = parseFlowPatch(text), after = applyOperations(before, patch);
  const proposal = { evidence, target: before, activeFlowId: state.activeFlowId,
    patchJson: JSON.stringify(patch), beforeJson: JSON.stringify(before), afterJson: JSON.stringify(after),
    addedCapabilities: after.capabilities.filter(cap => !before.capabilities.includes(cap)),
    trackingChanged: patch.operations.some(op => op.op === 'removeNode' || op.op === 'updateNode' && ('tracking' in op.patch || 'trackingKey' in op.patch)) };
  return { ...proposal, digest: proposalDigest(proposal) };
}

export function isFlowProposalCurrent(proposal: FlowProposal): boolean {
  const state = useViewerStore.getState();
  return editable(proposal.target) && state.activeFlowId === proposal.activeFlowId && evidenceIsCurrent(proposal.evidence)
    && JSON.stringify(proposal.target) === proposal.beforeJson;
}
export function isFlowReceiptCurrent(receipt: FlowApplyReceipt): boolean {
  const state = useViewerStore.getState();
  return editable(receipt.applied) && state.activeFlowId === receipt.proposal.activeFlowId
    && evidenceIsCurrent({ ...receipt.proposal.evidence, sourceIdentity: receipt.applied })
    && JSON.stringify(receipt.applied) === receipt.proposal.afterJson
    && JSON.stringify(receipt.proposal.target) === receipt.proposal.beforeJson;
}

/** Review commits only the graph. Model edits, network and execution need a later Run. */
export function applyFlowProposal(proposal: FlowProposal, reviewedDigest: string): FlowApplyReceipt {
  const state = useViewerStore.getState();
  if (reviewedDigest !== proposal.digest || proposalDigest(proposal) !== reviewedDigest) throw new Error('Reviewed proposal has changed');
  if (!isFlowProposalCurrent(proposal)) throw new Error('Graph or evidence changed after review');
  const candidate = applyOperations(proposal.target, parseFlowPatch(proposal.patchJson));
  if (JSON.stringify(candidate) !== proposal.afterJson) throw new Error('Native preview no longer matches the reviewed changes');
  // Synchronous native store boundary: no await can retarget the reviewed document.
  state.setFlowDoc(candidate);
  return { proposal, applied: candidate };
}

export function undoFlowProposal(receipt: FlowApplyReceipt): void {
  const state = useViewerStore.getState();
  if (!isFlowReceiptCurrent(receipt)) throw new Error('Graph changed after apply; graph undo was refused');
  state.setFlowDoc(receipt.proposal.target);
}
