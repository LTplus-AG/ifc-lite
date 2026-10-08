/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Strict `flow.create` envelope; registry checks live in `flow-create.ts` (#6919). */

import type { Lacing, TrackingMode } from '@ifc-lite/flow';
import { isBoundedFlowJson } from './flow-patch';

export interface FlowCreateRequest {
  version: 1; kind: 'flow.create'; name: string; description?: string;
  nodes: Array<{ id: string; type: string; params?: Record<string, unknown>; label?: string; pos?: [number, number];
    lacing?: Lacing; tracking?: TrackingMode; trackingKey?: string }>;
  edges: Array<{ from: [string, string]; to: [string, string] }>;
  outputs?: Array<{ nodeId: string; port: string; label: string }>;
}
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const LACINGS = ['shortest', 'longest', 'cross'];
const TRACKINGS = ['update', 'replace', 'disabled'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const pair = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && v.every(x => text(x, 200));
const only = (v: Record<string, unknown>, allowed: string[], required: string[]) =>
  Object.keys(v).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(v, k));

/** A complete envelope only: never promote a partial response or prose. */
export function parseFlowCreate(input: string): FlowCreateRequest {
  if (input.length > 48_000) throw new Error('Flow create proposal exceeds the text limit');
  const trimmed = input.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const raw: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
  if (!isBoundedFlowJson(raw) || !record(raw) || !only(raw, ['version', 'kind', 'name', 'description', 'nodes', 'edges', 'outputs'], ['version', 'kind', 'name', 'nodes', 'edges'])
    || raw.version !== 1 || raw.kind !== 'flow.create' || !text(raw.name, 120) || (raw.description !== undefined && typeof raw.description !== 'string')
    || (typeof raw.description === 'string' && raw.description.length > 2000)
    || !Array.isArray(raw.nodes) || !raw.nodes.length || raw.nodes.length > 60 || !Array.isArray(raw.edges) || raw.edges.length > 120
    || (raw.outputs !== undefined && (!Array.isArray(raw.outputs) || raw.outputs.length > 20))) throw new Error('Invalid bounded Flow create envelope');
  for (const node of raw.nodes) {
    if (!record(node) || !only(node, ['id', 'type', 'params', 'label', 'pos', 'lacing', 'tracking', 'trackingKey'], ['id', 'type'])
      || typeof node.id !== 'string' || !ID.test(node.id) || !text(node.type, 200) || (node.params !== undefined && !record(node.params))
      || (node.label !== undefined && !text(node.label, 120)) || (node.trackingKey !== undefined && !text(node.trackingKey, 200))
      || (node.lacing !== undefined && !LACINGS.includes(node.lacing as string)) || (node.tracking !== undefined && !TRACKINGS.includes(node.tracking as string))
      || (node.pos !== undefined && !(Array.isArray(node.pos) && node.pos.length === 2 && node.pos.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100_000)))) {
      throw new Error(`Invalid Flow create node: ${record(node) ? String(node.id) : '?'}`);
    }
  }
  for (const edge of raw.edges) if (!record(edge) || !only(edge, ['from', 'to'], ['from', 'to']) || !pair(edge.from) || !pair(edge.to)) throw new Error('Invalid Flow create edge');
  for (const output of raw.outputs ?? []) {
    if (!record(output) || !only(output, ['nodeId', 'port', 'label'], ['nodeId', 'port', 'label']) || !text(output.nodeId, 200) || !text(output.port, 200) || !text(output.label, 120)) {
      throw new Error('Invalid Flow create output');
    }
  }
  return raw as unknown as FlowCreateRequest;
}

