/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Node definitions and the registry that resolves a document's node types.
 *
 * A node is a pure description plus a `run` function that receives plain
 * values in the shape its ports declared (`item` → one value, `list` → an
 * array, `group` → a Map). The scheduler does all lifting; a node never sees
 * a `FlowData` container and never inspects the structure of its inputs.
 *
 * `H` is the host services type (in `@ifc-lite/flow-nodes`: `{ bim }`).
 * This package knows nothing about the SDK.
 */

import type { Access, GroupKey, PortType } from './values.js';

export interface PortDef {
  readonly name: string;
  readonly type: PortType;
  readonly doc?: string;
  /** An unconnected optional input receives `undefined`; a required one is a validation error. */
  readonly optional?: boolean;
  /** An `item` port that accepts `null` lanes instead of short-circuiting them. */
  readonly nullable?: boolean;
}

/**
 * `code` is a `string` the editor must give a multi-line editor to: a
 * one-line `<input>` is the only thing a script's source cannot be typed
 * into. Values are plain strings, so a host that has no code editor can
 * still fall back to the `string` field.
 */
export type ParamKind = 'string' | 'number' | 'boolean' | 'enum' | 'json' | 'code';

export interface ParamDef {
  readonly name: string;
  readonly kind: ParamKind;
  readonly default?: unknown;
  readonly options?: readonly string[];
  readonly doc?: string;
  /** Syntax for a `code` param, e.g. `javascript`. */
  readonly language?: string;
}

export type LogLevel = 'info' | 'warn' | 'error';

/** What a tracked write node must do for this lane (see `tracking.ts`). */
export interface LaneTracking {
  readonly action: 'create' | 'update' | 'keep';
  /** The element's GlobalId: stable across runs for the same tracking key + lane key. */
  readonly globalId: string;
}

export interface NodeRunContext<H> {
  readonly host: H;
  /** The lane this invocation computes, or `null` when the node was not lifted. */
  readonly laneKey: GroupKey | null;
  /** Present on tracked nodes' `run` only; `remove` gets the GlobalId as its argument instead. */
  readonly tracking?: LaneTracking;
  readonly signal?: AbortSignal;
  log(level: LogLevel, message: string): void;
}

/** Plain outputs keyed by port name, each in the shape the port's `access` declares. */
export type NodeOutputs = Readonly<Record<string, unknown>>;

export interface NodeDef<H = unknown, P = Readonly<Record<string, unknown>>> {
  /** Stable id, e.g. `model.queryByType`. */
  readonly type: string;
  readonly title: string;
  readonly category: string;
  readonly doc?: string;
  readonly inputs: readonly PortDef[];
  readonly outputs: readonly PortDef[];
  readonly params: readonly ParamDef[];
  /** Capability strings in the extension grammar (`model.read`, `model.mutate:Pset_X`). */
  readonly capabilities: readonly string[];
  /** Memo key includes model revisions when set; write nodes are never memoised. */
  readonly reads?: 'model';
  readonly writes?: 'model';
  /** Headless behaviour when a required backend feature is absent: `noop` runs as no-op. */
  readonly headless?: 'run' | 'noop';
  /** Host prerequisites the availability check tests for. */
  readonly requires?: {
    readonly backend?: readonly string[];
    readonly network?: boolean;
    readonly secrets?: readonly string[];
  };
  /** Name of the `item` input whose `EntityRef` value keys lanes (defaults to the first entity item port). */
  readonly laneKeyPort?: string;
  /**
   * A tracked node owns the elements it creates: the scheduler plans each
   * lane as create / update / keep against the node's tracked set and calls
   * `remove` for lanes that vanished since the last run.
   */
  readonly tracked?: boolean;
  remove?(ctx: NodeRunContext<H>, globalId: string): void | Promise<void>;
  run(ctx: NodeRunContext<H>, inputs: Readonly<Record<string, unknown>>, params: P): NodeOutputs | Promise<NodeOutputs>;
}

export class NodeRegistry<H = unknown> {
  private readonly defs = new Map<string, NodeDef<H>>();

  register(def: NodeDef<H>): this {
    if (this.defs.has(def.type)) throw new Error(`node type "${def.type}" is already registered`);
    for (const p of [...def.inputs, ...def.outputs]) assertAccess(def.type, p);
    this.defs.set(def.type, def);
    return this;
  }

  registerAll(defs: Iterable<NodeDef<H>>): this {
    for (const d of defs) this.register(d);
    return this;
  }

  get(type: string): NodeDef<H> | undefined {
    return this.defs.get(type);
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  list(): readonly NodeDef<H>[] {
    return [...this.defs.values()];
  }
}

const ACCESS: readonly Access[] = ['item', 'list', 'group'];

function assertAccess(type: string, port: PortDef): void {
  if (!ACCESS.includes(port.type.access)) {
    throw new Error(`node "${type}" port "${port.name}" has unknown access "${String(port.type.access)}"`);
  }
}

/** Resolve declared params with defaults; unknown keys are dropped, not passed through. */
export function resolveParams(def: NodeDef<unknown>, given: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of def.params) {
    const v = given?.[p.name];
    out[p.name] = v === undefined ? p.default : v;
  }
  return out;
}
