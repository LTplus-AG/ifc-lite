/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lifting: how a node declared over items/lists/groups is applied to the
 * structured data that actually arrives on its ports.
 *
 * Rules (the whole data-tree story fits in these):
 *  1. A `group` port receives the input as a group (an item or list becomes
 *     the single branch `""`). No lifting.
 *  2. If any `item`/`list` port receives a group, the node is lifted over
 *     the union of branch keys, and branches match **by key**, never by
 *     position. A key absent on a required port is reported under
 *     `missing`, and that lane is skipped.
 *  3. Inside a branch (or at top level), `item` ports that receive lists are
 *     laced: `shortest`, `longest` (repeat last), or `cross` (cartesian, key
 *     `i|j`). `list` ports receive the whole list. A single `item` value is
 *     broadcast.
 *  4. Lane keys come from the driving entity's GlobalId when there is one,
 *     else from the index — which is reported as a warning, because index
 *     lanes shift when the driving list changes and tracking then updates
 *     the wrong element.
 *  5. A `null` arriving on a non-nullable `item` port short-circuits that
 *     lane: `run` is not called and every output of the lane is `null`.
 */

import type { NodeOutputs, PortDef } from './registry.js';
import { asGroup, group, item, list, SINGLE_BRANCH } from './values.js';
import type { Access, EntityRef, FlowData, GroupKey, Lacing } from './values.js';

export interface LiftInput {
  readonly port: PortDef;
  /** `undefined` when the port is unconnected. */
  readonly data: FlowData | undefined;
}

export interface Lane {
  readonly laneKey: GroupKey | null;
  readonly branchKey: GroupKey | null;
  readonly args: Readonly<Record<string, unknown>>;
  /** True when a non-nullable item port received `null`: run is skipped. */
  readonly nullLane: boolean;
}

export interface LiftPlan {
  readonly lifted: boolean;
  readonly overGroup: boolean;
  readonly lanes: readonly Lane[];
  /** Per port, the branch keys it lacked while other ports had them. */
  readonly missing: Readonly<Record<string, readonly GroupKey[]>>;
  readonly warnings: readonly string[];
}

export interface LiftOptions {
  readonly lacing: Lacing;
  readonly maxCross: number;
  readonly laneKeyPort?: string;
}

export class CrossProductTooLarge extends Error {
  constructor(readonly size: number, readonly limit: number) {
    super(`cross lacing would produce ${size} lanes, above the limit of ${limit}`);
    this.name = 'CrossProductTooLarge';
  }
}

interface ListPort {
  readonly port: PortDef;
  readonly items: readonly unknown[];
}

function isEntityRef(v: unknown): v is EntityRef {
  return !!v && typeof v === 'object' && typeof (v as EntityRef).globalId === 'string';
}

function accessOf(input: LiftInput): Access {
  return input.port.type.access;
}

/** Lace `item` ports that hold lists inside one branch; returns lanes with `branchKey` unset. */
function laceBranch(
  fixed: Record<string, unknown>,
  laced: readonly ListPort[],
  opts: LiftOptions,
  warnings: string[],
): Array<{ innerKey: GroupKey; args: Record<string, unknown> }> {
  if (laced.length === 0) return [{ innerKey: SINGLE_BRANCH, args: fixed }];

  const keyOf = (port: PortDef, value: unknown, index: number): GroupKey => {
    if (isEntityRef(value) && (opts.laneKeyPort === undefined || opts.laneKeyPort === port.name)) return value.globalId;
    return String(index);
  };

  if (opts.lacing === 'cross') {
    const size = laced.reduce((n, l) => n * l.items.length, 1);
    if (size > opts.maxCross) throw new CrossProductTooLarge(size, opts.maxCross);
    const lanes: Array<{ innerKey: GroupKey; args: Record<string, unknown> }> = [];
    const idx = laced.map(() => 0);
    if (size === 0) return lanes;
    for (;;) {
      const args = { ...fixed };
      const keys: GroupKey[] = [];
      laced.forEach((l, p) => {
        args[l.port.name] = l.items[idx[p]];
        keys.push(keyOf(l.port, l.items[idx[p]], idx[p]));
      });
      lanes.push({ innerKey: keys.join('|'), args });
      let p = laced.length - 1;
      while (p >= 0) {
        idx[p] += 1;
        if (idx[p] < laced[p].items.length) break;
        idx[p] = 0;
        p -= 1;
      }
      if (p < 0) return lanes;
    }
  }

  const lengths = laced.map((l) => l.items.length);
  const n = opts.lacing === 'shortest' ? Math.min(...lengths) : Math.max(...lengths);
  const driver = laced.find((l) => opts.laneKeyPort === l.port.name) ?? laced.find((l) => l.items.some(isEntityRef)) ?? laced[0];
  let indexKeyed = false;
  const lanes: Array<{ innerKey: GroupKey; args: Record<string, unknown> }> = [];
  for (let i = 0; i < n; i += 1) {
    const args = { ...fixed };
    for (const l of laced) {
      const j = Math.min(i, l.items.length - 1);
      args[l.port.name] = l.items.length === 0 ? undefined : l.items[j];
    }
    const driverValue = driver.items[Math.min(i, driver.items.length - 1)];
    const key = keyOf(driver.port, driverValue, i);
    if (!isEntityRef(driverValue)) indexKeyed = true;
    lanes.push({ innerKey: key, args });
  }
  if (indexKeyed && n > 0) warnings.push(`lanes on "${driver.port.name}" are keyed by index; connect entities or set laneKeyPort for stable tracking`);
  return lanes;
}

function isNullLane(inputs: readonly LiftInput[], args: Record<string, unknown>): boolean {
  return inputs.some((i) => accessOf(i) === 'item' && !i.port.nullable && i.data !== undefined && args[i.port.name] === null);
}

export function planLift(inputs: readonly LiftInput[], opts: LiftOptions): LiftPlan {
  const warnings: string[] = [];
  const missing: Record<string, GroupKey[]> = {};
  const fixed: Record<string, unknown> = {};
  const groupCarriers: LiftInput[] = [];

  for (const input of inputs) {
    const access = accessOf(input);
    if (input.data === undefined) {
      fixed[input.port.name] = undefined;
      continue;
    }
    if (access === 'group') fixed[input.port.name] = asGroup(input.data);
    else if (input.data.kind === 'group') groupCarriers.push(input);
  }

  const buildLanes = (branchKey: GroupKey | null, branchOf: (input: LiftInput) => readonly unknown[] | undefined) => {
    const laneFixed = { ...fixed };
    const laced: ListPort[] = [];
    for (const input of inputs) {
      const access = accessOf(input);
      if (access === 'group' || input.data === undefined) continue;
      const branch = branchOf(input);
      if (branch === undefined) continue;
      if (access === 'list') laneFixed[input.port.name] = branch;
      else if (branch.length === 1 && input.data.kind === 'item') laneFixed[input.port.name] = branch[0];
      else laced.push({ port: input.port, items: branch });
    }
    const lanes = laceBranch(laneFixed, laced, opts, warnings);
    const lifted = laced.length > 0;
    return lanes.map((l): Lane => ({
      laneKey: branchKey === null ? (lifted ? l.innerKey : null) : lifted ? `${branchKey}|${l.innerKey}` : branchKey,
      branchKey,
      args: l.args,
      nullLane: isNullLane(inputs, l.args),
    }));
  };

  if (groupCarriers.length === 0) {
    const lanes = buildLanes(null, (input) => (input.data!.kind === 'item' ? [input.data!.value] : input.data!.kind === 'list' ? input.data!.items : undefined));
    return { lifted: lanes.length !== 1 || lanes[0].laneKey !== null, overGroup: false, lanes, missing, warnings };
  }

  const keys: GroupKey[] = [];
  const seen = new Set<GroupKey>();
  for (const c of groupCarriers) {
    for (const k of (c.data as { branches: ReadonlyMap<GroupKey, readonly unknown[]> }).branches.keys()) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }

  const lanes: Lane[] = [];
  for (const key of keys) {
    let skip = false;
    for (const c of groupCarriers) {
      const branches = (c.data as { branches: ReadonlyMap<GroupKey, readonly unknown[]> }).branches;
      if (!branches.has(key)) {
        (missing[c.port.name] ??= []).push(key);
        if (!c.port.optional) skip = true;
      }
    }
    if (skip) continue;
    lanes.push(
      ...buildLanes(key, (input) => {
        if (input.data!.kind === 'group') return input.data!.branches.get(key) ?? (input.port.optional ? undefined : []);
        return input.data!.kind === 'item' ? [input.data!.value] : input.data!.items;
      }),
    );
  }
  return { lifted: true, overGroup: true, lanes, missing, warnings };
}

/** Reassemble per-lane outputs into structured data, one entry per output port. */
export function assemble(plan: LiftPlan, outputs: readonly PortDef[], results: readonly (NodeOutputs | null)[]): Map<string, FlowData> {
  const out = new Map<string, FlowData>();
  if (!plan.lifted) {
    const r = results[0] ?? {};
    for (const port of outputs) {
      const v = r[port.name];
      const access = port.type.access;
      out.set(port.name, access === 'item' ? item(v ?? null) : access === 'list' ? list(asArray(v)) : group(asMap(v)));
    }
    return out;
  }
  for (const port of outputs) {
    const access = port.type.access;
    if (access === 'item' && !plan.overGroup) {
      out.set(port.name, list(plan.lanes.map((_, i) => results[i]?.[port.name] ?? null)));
      continue;
    }
    const branches = new Map<GroupKey, unknown[]>();
    plan.lanes.forEach((lane, i) => {
      const v = results[i]?.[port.name];
      if (access === 'item') {
        const k = lane.branchKey ?? SINGLE_BRANCH;
        (branches.get(k) ?? branches.set(k, []).get(k)!).push(v ?? null);
      } else if (access === 'list') {
        branches.set(lane.laneKey ?? SINGLE_BRANCH, [...asArray(v)]);
      } else {
        for (const [k, items] of asMap(v)) branches.set(`${lane.laneKey ?? SINGLE_BRANCH}|${k}`, [...items]);
      }
    });
    out.set(port.name, group(branches));
  }
  return out;
}

function asArray(v: unknown): readonly unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new TypeError('a list output must return an array');
  return v;
}

function asMap(v: unknown): ReadonlyMap<GroupKey, readonly unknown[]> {
  if (v === undefined || v === null) return new Map();
  if (!(v instanceof Map)) throw new TypeError('a group output must return a Map');
  return v as ReadonlyMap<GroupKey, readonly unknown[]>;
}
