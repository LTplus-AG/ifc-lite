/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the canvas draws for a document: React Flow nodes and edges derived
 * from the `FlowDocument` plus the last run. Pure, so the mapping is
 * testable and the canvas component stays a thin adapter.
 */

import type { Edge, Node } from '@xyflow/react';
import type { FlowData, FlowDocument, NodeDef, NodeRegistry, NodeReport, NodeStatus, PortDef, ValueKind } from '@ifc-lite/flow';

export interface FlowNodeData extends Record<string, unknown> {
  readonly nodeId: string;
  readonly type: string;
  readonly title: string;
  readonly category: string;
  readonly label?: string;
  readonly known: boolean;
  readonly inputs: readonly PortDef[];
  readonly outputs: readonly PortDef[];
  /** One-line summary of the params that differ from their defaults. */
  readonly summary: string;
  readonly status?: NodeStatus;
  readonly lanes?: number;
  readonly error?: string;
  readonly tracked: boolean;
  readonly isInput: boolean;
  readonly isOutput: boolean;
}

export type CanvasNode = Node<FlowNodeData, 'flow'>;
export type CanvasEdge = Edge;

/** Handle colour per value kind — the same palette in the palette, the node, and the inspector. */
export const KIND_COLOR: Readonly<Record<ValueKind, string>> = {
  scalar: '#9ece6a',
  entity: '#7aa2f7',
  point: '#e0af68',
  polyline: '#e0af68',
  placement: '#e0af68',
  profile: '#e0af68',
  elementSpec: '#bb9af7',
  table: '#7dcfff',
  any: '#a9b1d6',
};

export function edgeId(source: string, sourceHandle: string, target: string, targetHandle: string): string {
  return `${source}.${sourceHandle}->${target}.${targetHandle}`;
}

export function paramSummary(def: NodeDef<unknown> | undefined, params: Readonly<Record<string, unknown>> | undefined): string {
  if (!def || !params) return '';
  const parts: string[] = [];
  for (const p of def.params) {
    const v = params[p.name];
    if (v === undefined || v === p.default) continue;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${p.name}=${text.length > 24 ? `${text.slice(0, 24)}…` : text}`);
  }
  return parts.join('  ');
}

export function toCanvas(
  doc: FlowDocument,
  registry: NodeRegistry<unknown>,
  reports: ReadonlyMap<string, NodeReport> | undefined,
  selectedNodeId: string | null,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes = doc.nodes.map((n): CanvasNode => {
    const def = registry.get(n.type);
    const report = reports?.get(n.id);
    return {
      id: n.id,
      type: 'flow',
      position: { x: n.pos?.[0] ?? 0, y: n.pos?.[1] ?? 0 },
      selected: n.id === selectedNodeId,
      data: {
        nodeId: n.id,
        type: n.type,
        title: def?.title ?? n.type,
        category: def?.category ?? '?',
        label: n.label,
        known: def !== undefined,
        inputs: def?.inputs ?? [],
        outputs: def?.outputs ?? [],
        summary: paramSummary(def, n.params),
        status: report?.status,
        lanes: report?.lanes,
        error: report?.error,
        tracked: def?.tracked === true,
        isInput: doc.inputs.some((i) => i.nodeId === n.id),
        isOutput: doc.outputs.some((o) => o.nodeId === n.id),
      },
    };
  });
  const edges = doc.edges.map((e): CanvasEdge => ({
    id: edgeId(e.from[0], e.from[1], e.to[0], e.to[1]),
    source: e.from[0],
    sourceHandle: e.from[1],
    target: e.to[0],
    targetHandle: e.to[1],
    style: { stroke: KIND_COLOR[registry.get(doc.nodes.find((n) => n.id === e.from[0])?.type ?? '')?.outputs.find((p) => p.name === e.from[1])?.type.kind ?? 'any'] },
  }));
  return { nodes, edges };
}

/** A short, safe description of a value for the inspector and node badges. */
export function describeData(data: FlowData | undefined): string {
  if (!data) return '—';
  switch (data.kind) {
    case 'item':
      return 'item';
    case 'list':
      return `list · ${data.items.length}`;
    case 'group': {
      let n = 0;
      for (const b of data.branches.values()) n += b.length;
      return `group · ${data.branches.size} branch${data.branches.size === 1 ? '' : 'es'} · ${n}`;
    }
  }
}

/** Palette entries grouped by category, in registry order. */
export function paletteGroups(registry: NodeRegistry<unknown>, query: string): Array<{ category: string; defs: NodeDef<unknown>[] }> {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, NodeDef<unknown>[]>();
  for (const def of registry.list()) {
    if (q && !`${def.type} ${def.title} ${def.doc ?? ''}`.toLowerCase().includes(q)) continue;
    (groups.get(def.category) ?? groups.set(def.category, []).get(def.category)!).push(def);
  }
  return [...groups].map(([category, defs]) => ({ category, defs }));
}
