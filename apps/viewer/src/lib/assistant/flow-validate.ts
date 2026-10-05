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
