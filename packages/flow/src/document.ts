/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `*.flow.json` document: a git-diffable description of a graph.
 *
 * Hand-validated like extension manifests (no schema library), with a
 * migration chain keyed on `flowVersion`. Positions live here; tracked
 * element sets do not (they are model-specific and live in a sidecar, see
 * `tracking.ts`).
 */

import type { Lacing } from './values.js';

export const FLOW_VERSION = 1;

export type TrackingMode = 'update' | 'replace' | 'disabled';

/** Player input kinds — what a form can ask for (Dynamo Player parity). */
export type InputKind = 'scalar' | 'enum' | 'entitySet' | 'storey' | 'file' | 'table';

export interface FlowNode {
  readonly id: string;
  readonly type: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly lacing?: Lacing;
  readonly tracking?: TrackingMode;
  /** User-visible identity of a write node's output; drives GlobalIds. */
  readonly trackingKey?: string;
  readonly label?: string;
  readonly pos?: readonly [number, number];
}

export interface FlowEdge {
  readonly from: readonly [nodeId: string, port: string];
  readonly to: readonly [nodeId: string, port: string];
}

/** "Is Input": a node param the Player form sets. */
export interface FlowInput {
  readonly nodeId: string;
  readonly param: string;
  readonly label: string;
  readonly kind: InputKind;
  readonly options?: readonly string[];
}

/** "Is Output": a node port shown as a result. */
export interface FlowOutput {
  readonly nodeId: string;
  readonly port: string;
  readonly label: string;
}

export interface FlowDocument {
  readonly flowVersion: number;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly capabilities: readonly string[];
  readonly inputs: readonly FlowInput[];
  readonly outputs: readonly FlowOutput[];
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  /** Per-graph override of the cross-lacing guard. */
  readonly maxCross?: number;
}

export interface DocumentProblem {
  readonly path: string;
  readonly message: string;
}

const LACINGS: readonly string[] = ['shortest', 'longest', 'cross'];
const TRACKINGS: readonly string[] = ['update', 'replace', 'disabled'];
const INPUT_KINDS: readonly string[] = ['scalar', 'enum', 'entitySet', 'storey', 'file', 'table'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Structural validation of an untrusted document. Node *types* are checked
 * against a registry by the scheduler, not here, so a document can be
 * validated without one.
 */
export function validateFlowDocument(value: unknown): DocumentProblem[] {
  const problems: DocumentProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });
  if (!isRecord(value)) return [{ path: '', message: 'must be an object' }];

  if (value.flowVersion !== FLOW_VERSION) add('flowVersion', `must be ${FLOW_VERSION} (run migrateFlowDocument first)`);
  if (!str(value.id)) add('id', 'must be a non-empty string');
  if (!str(value.name)) add('name', 'must be a non-empty string');
  if (value.description !== undefined && typeof value.description !== 'string') add('description', 'must be a string');
  // `!Number.isFinite` first: `NaN < 1` is false, so a NaN bound would pass a
  // one-ended check and then disable the cross guard entirely (every
  // `size > NaN` is false).
  if (value.maxCross !== undefined && (typeof value.maxCross !== 'number' || !Number.isFinite(value.maxCross) || value.maxCross < 1)) add('maxCross', 'must be a finite number >= 1');

  for (const key of ['capabilities', 'inputs', 'outputs', 'nodes', 'edges'] as const) {
    if (!Array.isArray(value[key])) add(key, 'must be an array');
  }
  if (problems.length > 0) return problems;

  (value.capabilities as unknown[]).forEach((c, i) => {
    if (!str(c)) add(`capabilities[${i}]`, 'must be a non-empty string');
  });

  const nodeIds = new Set<string>();
  (value.nodes as unknown[]).forEach((n, i) => {
    const p = `nodes[${i}]`;
    if (!isRecord(n)) return add(p, 'must be an object');
    if (!str(n.id)) add(`${p}.id`, 'must be a non-empty string');
    else if (nodeIds.has(n.id)) add(`${p}.id`, `duplicate node id "${n.id}"`);
    else nodeIds.add(n.id);
    if (!str(n.type)) add(`${p}.type`, 'must be a non-empty string');
    if (n.params !== undefined && !isRecord(n.params)) add(`${p}.params`, 'must be an object');
    if (n.lacing !== undefined && !LACINGS.includes(n.lacing as string)) add(`${p}.lacing`, `must be one of ${LACINGS.join(', ')}`);
    if (n.tracking !== undefined && !TRACKINGS.includes(n.tracking as string)) add(`${p}.tracking`, `must be one of ${TRACKINGS.join(', ')}`);
    if (n.trackingKey !== undefined && !str(n.trackingKey)) add(`${p}.trackingKey`, 'must be a non-empty string');
    if (n.label !== undefined && typeof n.label !== 'string') add(`${p}.label`, 'must be a string');
    if (n.pos !== undefined && !(Array.isArray(n.pos) && n.pos.length === 2 && n.pos.every((x) => typeof x === 'number'))) add(`${p}.pos`, 'must be [x, y]');
  });

  const endpoint = (v: unknown, p: string): boolean => {
    if (!Array.isArray(v) || v.length !== 2 || !str(v[0]) || !str(v[1])) {
      add(p, 'must be [nodeId, port]');
      return false;
    }
    if (!nodeIds.has(v[0])) {
      add(p, `unknown node "${v[0]}"`);
      return false;
    }
    return true;
  };
  const targets = new Set<string>();
  (value.edges as unknown[]).forEach((e, i) => {
    const p = `edges[${i}]`;
    if (!isRecord(e)) return add(p, 'must be an object');
    endpoint(e.from, `${p}.from`);
    if (endpoint(e.to, `${p}.to`)) {
      const k = `${(e.to as string[])[0]}.${(e.to as string[])[1]}`;
      if (targets.has(k)) add(`${p}.to`, `input ${k} has more than one incoming edge`);
      targets.add(k);
    }
  });

  (value.inputs as unknown[]).forEach((inp, i) => {
    const p = `inputs[${i}]`;
    if (!isRecord(inp)) return add(p, 'must be an object');
    if (!str(inp.nodeId) || !nodeIds.has(inp.nodeId)) add(`${p}.nodeId`, 'must name a node');
    if (!str(inp.param)) add(`${p}.param`, 'must be a non-empty string');
    if (!str(inp.label)) add(`${p}.label`, 'must be a non-empty string');
    if (!INPUT_KINDS.includes(inp.kind as string)) add(`${p}.kind`, `must be one of ${INPUT_KINDS.join(', ')}`);
    if (inp.options !== undefined && !(Array.isArray(inp.options) && inp.options.every(str))) add(`${p}.options`, 'must be an array of strings');
  });
  (value.outputs as unknown[]).forEach((o, i) => {
    const p = `outputs[${i}]`;
    if (!isRecord(o)) return add(p, 'must be an object');
    if (!str(o.nodeId) || !nodeIds.has(o.nodeId)) add(`${p}.nodeId`, 'must name a node');
    if (!str(o.port)) add(`${p}.port`, 'must be a non-empty string');
    if (!str(o.label)) add(`${p}.label`, 'must be a non-empty string');
  });
  return problems;
}

/** Parse + validate; throws with every problem listed. */
export function parseFlowDocument(text: string): FlowDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`flow document is not valid JSON: ${(err as Error).message}`);
  }
  const migrated = migrateFlowDocument(value);
  const problems = validateFlowDocument(migrated);
  if (problems.length > 0) {
    throw new Error(`invalid flow document:\n${problems.map((p) => `  ${p.path || '<root>'}: ${p.message}`).join('\n')}`);
  }
  return migrated as FlowDocument;
}

/**
 * Migration chain: each step lifts `flowVersion` by one. There is only
 * version 1 today; the chain exists so a v1 file keeps opening after v2.
 */
export function migrateFlowDocument(value: unknown): unknown {
  if (!isRecord(value)) return value;
  let doc = value;
  while (typeof doc.flowVersion === 'number' && doc.flowVersion < FLOW_VERSION) {
    const step = MIGRATIONS[doc.flowVersion];
    if (!step) break;
    doc = step(doc);
  }
  return doc;
}

const MIGRATIONS: Readonly<Record<number, (doc: Record<string, unknown>) => Record<string, unknown>>> = {};
