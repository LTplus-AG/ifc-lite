/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure edits on a `FlowDocument`. The canvas and inspector call these and
 * store the result; nothing here touches React or the store, so the whole
 * editing model is testable without a DOM.
 *
 * Connecting checks the value kinds at both ends (`isAssignable`), replaces
 * an existing edge into the same input (an input has at most one source),
 * and refuses a cycle. Deleting a node drops its edges and any Player
 * input/output markers that pointed at it.
 */

import { isAssignable, topologicalOrder, type FlowDocument, type FlowEdge, type FlowNode, type NodeDef, type NodeRegistry, type PortType, type TrackingMode, type Lacing } from '@ifc-lite/flow';

export interface ConnectResult {
  readonly doc: FlowDocument;
  readonly error?: string;
}

function nodeDef(doc: FlowDocument, registry: NodeRegistry<unknown>, nodeId: string): NodeDef<unknown> | undefined {
  const node = doc.nodes.find((n) => n.id === nodeId);
  return node ? registry.get(node.type) : undefined;
}

/** A node id that is unique in the document: `<type tail>-<n>`. */
export function nextNodeId(doc: FlowDocument, type: string): string {
  const tail = type.split('.').pop() ?? 'node';
  let n = 1;
  while (doc.nodes.some((node) => node.id === `${tail}-${n}`)) n += 1;
  return `${tail}-${n}`;
}

export function addNode(doc: FlowDocument, type: string, pos: readonly [number, number]): { doc: FlowDocument; nodeId: string } {
  const nodeId = nextNodeId(doc, type);
  return { doc: { ...doc, nodes: [...doc.nodes, { id: nodeId, type, pos: [pos[0], pos[1]] }] }, nodeId };
}

export function removeNode(doc: FlowDocument, nodeId: string): FlowDocument {
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => n.id !== nodeId),
    edges: doc.edges.filter((e) => e.from[0] !== nodeId && e.to[0] !== nodeId),
    inputs: doc.inputs.filter((i) => i.nodeId !== nodeId),
    outputs: doc.outputs.filter((o) => o.nodeId !== nodeId),
  };
}

export function moveNode(doc: FlowDocument, nodeId: string, pos: readonly [number, number]): FlowDocument {
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === nodeId ? { ...n, pos: [pos[0], pos[1]] } : n)) };
}

export function updateNode(doc: FlowDocument, nodeId: string, patch: Partial<Pick<FlowNode, 'params' | 'label' | 'lacing' | 'tracking' | 'trackingKey'>>): FlowDocument {
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) };
}

export function setParam(doc: FlowDocument, nodeId: string, param: string, value: unknown): FlowDocument {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) return doc;
  const params = { ...node.params };
  if (value === undefined) delete params[param];
  else params[param] = value;
  return updateNode(doc, nodeId, { params });
}

export function setLacing(doc: FlowDocument, nodeId: string, lacing: Lacing): FlowDocument {
  return updateNode(doc, nodeId, { lacing });
}

export function setTracking(doc: FlowDocument, nodeId: string, tracking: TrackingMode, trackingKey?: string): FlowDocument {
  return updateNode(doc, nodeId, { tracking, trackingKey: trackingKey && trackingKey.length > 0 ? trackingKey : undefined });
}

/**
 * The declared types at both ends of a candidate edge, or `undefined` for
 * an end that names no such port. Shared by `connect` and the canvas's
 * live drag validation so the two cannot disagree about what fits.
 */
export function portTypes(
  doc: FlowDocument,
  registry: NodeRegistry<unknown>,
  fromId: string,
  fromPort: string,
  toId: string,
  toPort: string,
): { out: PortType | undefined; inp: PortType | undefined } {
  return {
    out: nodeDef(doc, registry, fromId)?.outputs.find((p) => p.name === fromPort)?.type,
    inp: nodeDef(doc, registry, toId)?.inputs.find((p) => p.name === toPort)?.type,
  };
}

export function connect(doc: FlowDocument, registry: NodeRegistry<unknown>, edge: FlowEdge): ConnectResult {
  const [fromId, fromPort] = edge.from;
  const [toId, toPort] = edge.to;
  if (fromId === toId) return { doc, error: 'a node cannot feed itself' };
  const { out, inp } = portTypes(doc, registry, fromId, fromPort, toId, toPort);
  if (!out) return { doc, error: `no output "${fromPort}" on ${fromId}` };
  if (!inp) return { doc, error: `no input "${toPort}" on ${toId}` };
  if (!isAssignable(out, inp)) return { doc, error: `${out.kind} cannot feed ${inp.kind}` };
  const edges = [...doc.edges.filter((e) => !(e.to[0] === toId && e.to[1] === toPort)), { from: [fromId, fromPort], to: [toId, toPort] } satisfies FlowEdge];
  const next = { ...doc, edges };
  try {
    topologicalOrder(next);
  } catch {
    return { doc, error: 'that connection would create a cycle' };
  }
  return { doc: next };
}

export function disconnect(doc: FlowDocument, toId: string, toPort: string): FlowDocument {
  return { ...doc, edges: doc.edges.filter((e) => !(e.to[0] === toId && e.to[1] === toPort)) };
}

/** Toggle a param as a Player input ("Is Input"). */
export function toggleInput(doc: FlowDocument, nodeId: string, param: string, label?: string): FlowDocument {
  const has = doc.inputs.some((i) => i.nodeId === nodeId && i.param === param);
  if (has) return { ...doc, inputs: doc.inputs.filter((i) => !(i.nodeId === nodeId && i.param === param)) };
  return { ...doc, inputs: [...doc.inputs, { nodeId, param, label: label ?? `${nodeId}.${param}`, kind: 'scalar' }] };
}

/** Toggle a port as a graph output ("Is Output"). */
export function toggleOutput(doc: FlowDocument, nodeId: string, port: string, label?: string): FlowDocument {
  const has = doc.outputs.some((o) => o.nodeId === nodeId && o.port === port);
  if (has) return { ...doc, outputs: doc.outputs.filter((o) => !(o.nodeId === nodeId && o.port === port)) };
  return { ...doc, outputs: [...doc.outputs, { nodeId, port, label: label ?? `${nodeId}.${port}` }] };
}

/** The capabilities the document's nodes declare, unioned — what a run must be granted. */
export function requiredCapabilities(doc: FlowDocument, registry: NodeRegistry<unknown>): string[] {
  const caps = new Set<string>();
  for (const n of doc.nodes) for (const c of registry.get(n.type)?.capabilities ?? []) caps.add(c);
  return [...caps].sort();
}
