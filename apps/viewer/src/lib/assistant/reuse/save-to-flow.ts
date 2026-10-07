/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Save-to-Flow (viewer AI P20): turn an assistant conversation into a
 * reusable native Flow graph. The graph holds references and parameters
 * only — which analysis to run (native nodes with run-time file slots), the
 * user's prompts and the reviewed action kinds — never credentials, model
 * data or captured evidence values. Assistant answers are not saved.
 *
 * SEAM (P19): executable Flow AI nodes are not registered on this branch.
 * Prompts and proposal reviews become PLACEHOLDER nodes whose types are
 * listed in `PENDING_NODE_TYPES`. The native editor shows them as unknown
 * nodes and the native runner refuses the whole graph, naming them
 * (`checkAvailability` → "unknown node type"), so nothing half-runs. When the
 * AI node package registers these types (or this table is pointed at the
 * names it registers), the same saved graphs become runnable. Placeholders
 * are deliberately not wired: their ports are defined by that package; the
 * `evidenceFrom` / `proposalFrom` parameters name the upstream node instead.
 * Clash detection has no native Flow node yet either, so a clash source is a
 * placeholder of the same kind.
 */

import { validateFlowDocument, validateFlowWiring, FLOW_VERSION, type FlowDocument, type FlowEdge, type FlowInput,
  type FlowNode, type FlowOutput, type NodeRegistry } from '@ifc-lite/flow';
import { requiredCapabilities } from '../../flow/editor-ops';
import { isFlowWithinSizeLimit } from '../../flow/persistence';
import type { AssistantMessage } from '../persistence';
import type { AssistantSource } from '../sources';
import { containsCredential } from './credentials';
import type { ReviewedAction } from './recipe';

export const PENDING_NODE_TYPES = { prompt: 'ai.prompt', review: 'ai.reviewProposal', clash: 'clash.runChecks' } as const;
const PENDING = new Set<string>(Object.values(PENDING_NODE_TYPES));
/** Placeholders are pending types the given registry does not (yet) provide. */
export function placeholderNodes(doc: FlowDocument, registry: NodeRegistry<unknown>): FlowNode[] {
  return doc.nodes.filter(node => PENDING.has(node.type) && !registry.get(node.type));
}

export interface WorkflowSpec { name: string; source: AssistantSource; prompts: string[]; actions: ReviewedAction[] }
export type SaveRefusal = 'flow-source' | 'no-prompts' | 'credential' | 'too-large';
export type WorkflowGraph = { ok: true; doc: FlowDocument; placeholders: string[] } | { ok: false; reason: SaveRefusal };

/** User prompts and the action kinds of valid typed proposals; `actionOf` is the panel's own proposal reader. */
export function conversationWorkflowSpec(name: string, source: AssistantSource, messages: readonly AssistantMessage[],
  actionOf: (content: string) => ReviewedAction | null): WorkflowSpec {
  const prompts = messages.filter(message => message.role === 'user').map(message => message.content.trim()).filter(Boolean);
  const actions = [...new Set(messages.flatMap(message => {
    const action = message.role === 'assistant' ? actionOf(message.content) : null;
    return action ? [action] : [];
  }))];
  return { name, source, prompts, actions };
}

const SLOT_MODELS: FlowInput = { nodeId: 'load', param: 'files', label: 'Models', kind: 'files',
  fileSlots: [{ id: 'models', label: 'IFC models', accept: '.ifc', multiple: true, required: true }] };
const PLACEHOLDER_LABEL = 'Placeholder — needs Flow AI nodes; refuses to run';

export function buildWorkflowGraph(spec: WorkflowSpec, registry: NodeRegistry<unknown>): WorkflowGraph {
  // A graph discussion is already a native graph: native Save keeps it reusable.
  if (spec.source === 'flow') return { ok: false, reason: 'flow-source' };
  if (!spec.prompts.length) return { ok: false, reason: 'no-prompts' };
  if (containsCredential([spec.name, ...spec.prompts])) return { ok: false, reason: 'credential' };
  const nodes: FlowNode[] = [{ id: 'load', type: 'session.loadModels', params: { files: {}, selectors: [] }, tracking: 'disabled', pos: [0, 0] }];
  const edges: FlowEdge[] = [];
  const inputs: FlowInput[] = [SLOT_MODELS];
  const outputs: FlowOutput[] = [];
  let x = 260;
  const column = () => { const pos: [number, number] = [x, 0]; x += 260; return pos; };
  let evidence = 'load';
  if (spec.source === 'validation' || spec.source === 'compare') {
    const validation = spec.source === 'validation';
    evidence = validation ? 'checks' : 'compare';
    nodes.push({ id: evidence, type: validation ? 'validation.runChecks' : 'comparison.runChecks', params: { jobs: [], files: {} }, pos: column() });
    edges.push({ from: ['load', 'models'], to: [evidence, 'models'] });
    inputs.push({ nodeId: evidence, param: 'files', label: validation ? 'Checks' : 'Comparison recipes', kind: 'files', fileSlots: [validation
      ? { id: 'checks', label: 'IDS or information rule sets', accept: '.ids,.json', multiple: true, required: true }
      : { id: 'recipes', label: 'Comparison recipe JSON', accept: '.comparison.json,.json', multiple: true, required: true }] });
    outputs.push({ nodeId: evidence, port: 'reports', label: validation ? 'Validation evidence' : 'Comparison evidence' });
  } else if (spec.source === 'clash') {
    evidence = 'clash';
    nodes.push({ id: 'clash', type: PENDING_NODE_TYPES.clash, label: 'Placeholder — no native clash node yet; refuses to run',
      params: { evidenceFrom: 'load' }, pos: column() });
  }
  let previous = evidence;
  spec.prompts.forEach((prompt, index) => {
    const id = `ask-${index + 1}`;
    nodes.push({ id, type: PENDING_NODE_TYPES.prompt, label: PLACEHOLDER_LABEL,
      params: { prompt, source: spec.source, evidenceFrom: evidence, after: previous }, pos: column() });
    previous = id;
  });
  for (const action of spec.actions) {
    if (action === 'report.draft') {
      nodes.push({ id: 'report', type: 'report.buildDocument', params: { config: { name: spec.name } }, pos: column() });
      if (evidence === 'checks') edges.push({ from: ['checks', 'reports'], to: ['report', 'validation'] });
      if (evidence === 'compare') edges.push({ from: ['compare', 'reports'], to: ['report', 'comparisons'] });
      outputs.push({ nodeId: 'report', port: 'document', label: 'Open report document' });
    } else {
      nodes.push({ id: `review-${action.replace('.', '-')}`, type: PENDING_NODE_TYPES.review, label: PLACEHOLDER_LABEL,
        params: { action, proposalFrom: previous }, pos: column() });
    }
  }
  const draft: FlowDocument = { flowVersion: FLOW_VERSION, id: crypto.randomUUID(), name: spec.name,
    description: 'Saved from an assistant conversation: native analysis nodes, the prompts and the reviewed action kinds. '
      + 'Placeholder nodes refuse to run until Flow AI nodes are available; every proposal still needs review.',
    capabilities: [], inputs, outputs, nodes, edges };
  const doc: FlowDocument = { ...draft, capabilities: requiredCapabilities(draft, registry) };
  const placeholders = placeholderNodes(doc, registry).map(node => node.id);
  const unexpected = [...validateFlowDocument(doc), ...validateFlowWiring(doc, registry)]
    .filter(problem => !placeholders.some(id => problem.message.includes(`(${id})`)));
  if (unexpected.length) throw new Error(`Generated workflow failed native validation: ${unexpected.map(p => `${p.path}: ${p.message}`).join('; ')}`);
  if (!isFlowWithinSizeLimit(doc)) return { ok: false, reason: 'too-large' };
  return { ok: true, doc, placeholders };
}
