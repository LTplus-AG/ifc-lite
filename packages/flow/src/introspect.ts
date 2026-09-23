/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared flow introspection + input-validation helpers used by every
 * headless caller of a `.flow.json` graph: the CLI's `flow describe`/`flow
 * run` and MCP's `describe_flow`/`run_flow`.
 *
 * Kept in one place because the input-validation rule here is a
 * correctness rule, not a formatting choice. The CLI had exactly this bug
 * once: `--input rating=REI90` (missing the node id) named no declared
 * parameter, was silently dropped, and the graph ran on its defaults while
 * reporting success (issue #5167). A second, independently written copy of
 * "is this key a declared parameter" in another caller is exactly how that
 * regresses somewhere else — so both go through {@link resolveDeclaredParam}.
 */

import type { FlowDocument, InputKind } from './document.js';
import type { NodeRegistry, ParamDef, ParamKind } from './registry.js';
import type { Access, ValueKind } from './values.js';

export interface FlowInputInfo {
  readonly key: string;
  readonly label: string;
  readonly kind: InputKind;
  readonly options?: readonly string[];
  readonly default?: unknown;
  readonly paramKind?: ParamKind;
}

export interface FlowOutputInfo {
  readonly key: string;
  readonly label: string;
  readonly kind?: ValueKind;
  readonly access?: Access;
}

export interface FlowIO {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly capabilities: readonly string[];
  readonly inputs: readonly FlowInputInfo[];
  readonly outputs: readonly FlowOutputInfo[];
}

/** The declared inputs/outputs schema of a graph — the Hops `/io` equivalent. */
export function describeFlowIO(doc: FlowDocument, registry: NodeRegistry<unknown>): FlowIO {
  const inputs = doc.inputs.map((i) => {
    const def = registry.get(doc.nodes.find((n) => n.id === i.nodeId)?.type ?? '');
    const param = def?.params.find((p) => p.name === i.param);
    return { key: `${i.nodeId}.${i.param}`, label: i.label, kind: i.kind, options: i.options, default: param?.default, paramKind: param?.kind };
  });
  const outputs = doc.outputs.map((o) => {
    const def = registry.get(doc.nodes.find((n) => n.id === o.nodeId)?.type ?? '');
    const port = def?.outputs.find((p) => p.name === o.port);
    return { key: `${o.nodeId}.${o.port}`, label: o.label, kind: port?.type.kind, access: port?.type.access };
  });
  return { id: doc.id, name: doc.name, description: doc.description, capabilities: doc.capabilities, inputs, outputs };
}

/** `nodeId.param` for every declared Player input — the list a caller echoes back on a bad key. */
export function declaredInputKeys(doc: FlowDocument): readonly string[] {
  return doc.inputs.map((i) => `${i.nodeId}.${i.param}`);
}

/**
 * Resolve a `nodeId.param` input key against the document + registry — the
 * ONE lookup every caller uses to decide whether a key is a declared
 * parameter. Returns undefined for a malformed key (no dot), a key naming
 * no node, or a node with no such param — regardless of whether the key
 * also appears in `doc.inputs` (a node can accept a param override the
 * Player form never exposed).
 */
export function resolveDeclaredParam(
  key: string,
  doc: FlowDocument,
  registry: NodeRegistry<unknown>,
): { readonly nodeId: string; readonly param: ParamDef } | undefined {
  const dot = key.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const nodeId = key.slice(0, dot);
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;
  const param = registry.get(node.type)?.params.find((p) => p.name === key.slice(dot + 1));
  return param ? { nodeId, param } : undefined;
}

/**
 * Every key in `inputs` that names no declared parameter. Empty when every
 * key resolves. A run must refuse rather than silently ignore any key this
 * returns — see the module doc for why.
 */
export function unknownInputKeys(
  inputs: Readonly<Record<string, unknown>> | undefined,
  doc: FlowDocument,
  registry: NodeRegistry<unknown>,
): readonly string[] {
  if (!inputs) return [];
  return Object.keys(inputs).filter((key) => !resolveDeclaredParam(key, doc, registry));
}
