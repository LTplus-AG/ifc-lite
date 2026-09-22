/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Per-node input gathering for the scheduler: edges → lift inputs, wiring problems, and no-op pass-through outputs. */

import type { FlowDocument, FlowNode } from './document.js';
import type { LiftInput } from './lift.js';
import type { NodeDef, NodeRegistry } from './registry.js';
import { isAssignable, item, type FlowData } from './values.js';

export interface Prepared {
  readonly inputs: LiftInput[];
  readonly problems: string[];
  readonly skipped: boolean;
}

export function prepareInputs(
  doc: FlowDocument,
  node: FlowNode,
  def: NodeDef<unknown>,
  registry: NodeRegistry<unknown>,
  outputs: Map<string, Map<string, FlowData>>,
  failed: Set<string>,
): Prepared {
  const problems: string[] = [];
  let skipped = false;
  const inputs: LiftInput[] = def.inputs.map((port) => {
    const edge = doc.edges.find((e) => e.to[0] === node.id && e.to[1] === port.name);
    if (!edge) {
      if (!port.optional) problems.push(`required input "${port.name}" is not connected`);
      return { port, data: undefined };
    }
    const [srcId, srcPort] = edge.from;
    if (failed.has(srcId)) skipped = true;
    const srcNode = doc.nodes.find((n) => n.id === srcId);
    const srcDef = srcNode ? registry.get(srcNode.type) : undefined;
    const srcPortDef = srcDef?.outputs.find((p) => p.name === srcPort);
    if (!srcPortDef) problems.push(`edge from ${srcId}.${srcPort}: no such output`);
    else if (!isAssignable(srcPortDef.type, port.type)) {
      problems.push(`edge from ${srcId}.${srcPort} (${srcPortDef.type.kind}) cannot feed "${port.name}" (${port.type.kind})`);
    }
    return { port, data: outputs.get(srcId)?.get(srcPort) };
  });
  return { inputs, problems, skipped };
}

export function noopOutputs(def: NodeDef<unknown>, inputs: readonly LiftInput[]): Map<string, FlowData> {
  // A no-op node passes through any input whose name matches an output
  // (so `viewer.colorize(entities) → entities` still chains), else empties.
  const out = new Map<string, FlowData>();
  for (const port of def.outputs) {
    const same = inputs.find((i) => i.port.name === port.name)?.data;
    out.set(port.name, same ?? (port.type.access === 'item' ? item(null) : port.type.access === 'list' ? { kind: 'list', items: [] } : { kind: 'group', branches: new Map() }));
  }
  return out;
}
