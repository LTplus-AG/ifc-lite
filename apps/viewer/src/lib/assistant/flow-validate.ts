/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseCapabilities } from '@ifc-lite/extensions';
import { topologicalOrder, validateFlowDocument, validateFlowWiring, type FlowDocument, type ParamDef } from '@ifc-lite/flow';
import { flowRegistry } from '../flow/runner';
import { isBoundedFlowJson } from './flow-patch';

/** Review limits shared by patch and create proposals. */
export const FLOW_REVIEW_LIMITS = { nodes: 100, edges: 200, bytes: 500_000 } as const;

/** A parameter value that the native editor could have produced for this declaration. */
export function isNativeParamValue(definition: ParamDef, value: unknown): boolean {
  if (definition.kind === 'json') return true;
  if (definition.kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (definition.kind === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string' && (definition.kind !== 'enum' || (definition.options?.includes(value) ?? false));
}

/** A `code` parameter (script source) a proposal writes: it runs on the next Run, so review shows it verbatim. */
export interface FlowCodeParam { readonly nodeId: string; readonly param: string; readonly language: string | null; readonly code: string }

/** Code parameters of `after` that are new or changed relative to `before` (every one for a new graph). */
export function changedCodeParams(before: FlowDocument | null, after: FlowDocument): FlowCodeParam[] {
  const registry = flowRegistry();
  const previous = new Map(before?.nodes.map(node => [node.id, node]));
  return after.nodes.flatMap(node => (registry.get(node.type)?.params ?? [])
    .filter(def => def.kind === 'code' && typeof node.params?.[def.name] === 'string'
      && previous.get(node.id)?.params?.[def.name] !== node.params[def.name])
    .map(def => ({ nodeId: node.id, param: def.name, language: def.language ?? null, code: node.params![def.name] as string })));
}

/**
 * Native document, registry wiring (types, ports, port types, required inputs),
 * capability grammar and cycle checks. Throws the first problems verbatim.
 */
export function validateProposedGraph(doc: FlowDocument): void {
  if (!isBoundedFlowJson(doc) || doc.nodes.length > FLOW_REVIEW_LIMITS.nodes || doc.edges.length > FLOW_REVIEW_LIMITS.edges
    || JSON.stringify(doc).length > FLOW_REVIEW_LIMITS.bytes) {
    throw new Error('Graph exceeds the proposal review limits');
  }
  const problems = [...validateFlowDocument(doc), ...validateFlowWiring(doc, flowRegistry())];
  if (problems.length) throw new Error(problems.slice(0, 10).map(p => `${p.path}: ${p.message}`).join('\n'));
  const grants = parseCapabilities(doc.capabilities);
  if (!grants.ok) throw new Error(grants.errors.map(e => e.message).join('; '));
  topologicalOrder(doc);
}
