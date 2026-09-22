/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Registry-aware validation: the half `validateFlowDocument` cannot do.
 *
 * The document validator is structural — it can say `edges[0].from` is
 * `[nodeId, port]` and that the node exists, but not that the node HAS that
 * port, because it deliberately works without a registry. Everything that
 * needs to know what a node type actually declares lives here: unknown node
 * types, edge endpoints naming ports that do not exist, type-incompatible
 * edges, and Player `inputs` / graph `outputs` pointing at parameters and
 * ports that are not there.
 *
 * Without this, a graph whose declared output names a missing port passed
 * validation, reported `ok: true`, exited 0 — and then produced nothing for
 * that output at run time. A validator that cannot see the defect it is
 * asked about reads as success, which is worse than not running at all.
 */

import type { FlowDocument, DocumentProblem } from './document.js';
import type { NodeRegistry } from './registry.js';
import { isAssignable } from './values.js';

export function validateFlowWiring(doc: FlowDocument, registry: NodeRegistry<unknown>): DocumentProblem[] {
  const problems: DocumentProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });
  const defOf = (nodeId: string) => {
    const node = doc.nodes.find((n) => n.id === nodeId);
    return node ? registry.get(node.type) : undefined;
  };

  doc.nodes.forEach((n, i) => {
    if (!registry.get(n.type)) add(`nodes[${i}]`, `unknown node type "${n.type}" (${n.id})`);
  });

  doc.edges.forEach((e, i) => {
    const from = defOf(e.from[0])?.outputs.find((p) => p.name === e.from[1]);
    const to = defOf(e.to[0])?.inputs.find((p) => p.name === e.to[1]);
    if (defOf(e.from[0]) && !from) add(`edges[${i}].from`, `node "${e.from[0]}" has no output "${e.from[1]}"`);
    if (defOf(e.to[0]) && !to) add(`edges[${i}].to`, `node "${e.to[0]}" has no input "${e.to[1]}"`);
    if (from && to && !isAssignable(from.type, to.type)) {
      add(`edges[${i}]`, `${e.from[0]}.${e.from[1]} (${from.type.kind}) cannot feed ${e.to[0]}.${e.to[1]} (${to.type.kind})`);
    }
  });

  doc.inputs.forEach((input, i) => {
    const def = defOf(input.nodeId);
    if (def && !def.params.some((p) => p.name === input.param)) {
      add(`inputs[${i}]`, `node "${input.nodeId}" has no parameter "${input.param}"`);
    }
  });

  doc.outputs.forEach((output, i) => {
    const def = defOf(output.nodeId);
    if (def && !def.outputs.some((p) => p.name === output.port)) {
      add(`outputs[${i}]`, `node "${output.nodeId}" has no output "${output.port}"`);
    }
  });

  // Required inputs with nothing connected: the scheduler fails the node at
  // run time, so a validator that stayed silent here would promise a run it
  // knows cannot happen.
  for (const node of doc.nodes) {
    const def = registry.get(node.type);
    if (!def) continue;
    for (const port of def.inputs) {
      if (port.optional) continue;
      if (!doc.edges.some((e) => e.to[0] === node.id && e.to[1] === port.name)) {
        add(`nodes[${doc.nodes.indexOf(node)}]`, `required input "${port.name}" of "${node.id}" is not connected`);
      }
    }
  }

  return problems;
}
