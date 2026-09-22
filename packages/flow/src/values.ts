/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The flow data model.
 *
 * Every value travelling along an edge is wrapped in an explicit container
 * (`FlowData`) that says how it is structured — one item, an ordered list,
 * or a group of lists keyed by string. Nodes never sniff shapes: a port
 * declares the `access` it wants and the scheduler lifts the node over the
 * container (see `lift.ts`). That single rule replaces Grasshopper's data
 * trees (paths, Path Mapper, Simplify) and Dynamo's list levels with one
 * keyed level, which is what BIM data actually is: keyed by GlobalId,
 * storey, sheet name, grid intersection.
 *
 * Values are plain data. An entity is a *handle* (`EntityRef`), never a copy
 * of its properties; nodes read what they need through `bim.*` on demand.
 */

// ── Structure ────────────────────────────────────────────────

/** How a port consumes or produces data. */
export type Access = 'item' | 'list' | 'group';

/** How an `item` port is lifted over lists (Dynamo lacing). */
export type Lacing = 'shortest' | 'longest' | 'cross';

/** A group key: a string so it survives JSON and sidecars unchanged. */
export type GroupKey = string;

export type FlowData<T = unknown> =
  | { readonly kind: 'item'; readonly value: T }
  | { readonly kind: 'list'; readonly items: readonly T[] }
  | { readonly kind: 'group'; readonly branches: ReadonlyMap<GroupKey, readonly T[]> };

export function item<T>(value: T): FlowData<T> {
  return { kind: 'item', value };
}

export function list<T>(items: readonly T[]): FlowData<T> {
  return { kind: 'list', items };
}

export function group<T>(branches: ReadonlyMap<GroupKey, readonly T[]> | Iterable<readonly [GroupKey, readonly T[]]>): FlowData<T> {
  return { kind: 'group', branches: branches instanceof Map ? branches : new Map(branches) };
}

/** The branch key a plain list occupies when a `group` port receives it. */
export const SINGLE_BRANCH: GroupKey = '';

/** Total item count regardless of structure. */
export function countItems(data: FlowData): number {
  switch (data.kind) {
    case 'item':
      return 1;
    case 'list':
      return data.items.length;
    case 'group': {
      let n = 0;
      for (const items of data.branches.values()) n += items.length;
      return n;
    }
  }
}

/** Flatten any structure to a list, branch order preserved. */
export function flatten<T>(data: FlowData<T>): readonly T[] {
  switch (data.kind) {
    case 'item':
      return [data.value];
    case 'list':
      return data.items;
    case 'group': {
      const out: T[] = [];
      for (const items of data.branches.values()) out.push(...items);
      return out;
    }
  }
}

/** View any structure as a group: an item or list becomes the single branch. */
export function asGroup<T>(data: FlowData<T>): ReadonlyMap<GroupKey, readonly T[]> {
  switch (data.kind) {
    case 'item':
      return new Map([[SINGLE_BRANCH, [data.value]]]);
    case 'list':
      return new Map([[SINGLE_BRANCH, data.items]]);
    case 'group':
      return data.branches;
  }
}

// ── Value types ──────────────────────────────────────────────

export type Scalar = string | number | boolean | null;

/**
 * An entity handle. `globalId` is the identity that survives reloads,
 * exports and layer publishes; `modelId`/`expressId` are the host's
 * session-scoped address for it and may be re-resolved. Keys, joins and
 * tracking use `globalId`; reads through `bim.*` use the address.
 */
export interface EntityRef {
  readonly globalId: string;
  readonly modelId?: string;
  readonly expressId?: number;
}

export type Point = readonly [number, number, number];

export interface Polyline {
  readonly points: readonly Point[];
  readonly closed: boolean;
}

export interface Placement {
  readonly position: Point;
  /** Rotation about Z in degrees. */
  readonly rotationZ: number;
}

/** Parametric profiles — the shapes `@ifc-lite/create` can author. No BRep. */
export type Profile =
  | { readonly kind: 'rectangle'; readonly width: number; readonly depth: number }
  | { readonly kind: 'circle'; readonly radius: number }
  | { readonly kind: 'hollowCircle'; readonly radius: number; readonly wallThickness: number }
  | { readonly kind: 'hollowRectangle'; readonly width: number; readonly depth: number; readonly wallThickness: number }
  | { readonly kind: 'I' | 'L' | 'T' | 'U'; readonly width: number; readonly depth: number; readonly webThickness: number; readonly flangeThickness: number };

/** The value kinds a port can carry. `any` accepts everything (Watch, Script). */
export type ValueKind =
  | 'scalar'
  | 'entity'
  | 'point'
  | 'polyline'
  | 'placement'
  | 'profile'
  | 'elementSpec'
  | 'table'
  | 'any';

/** A port's static type: what kind of value, and how it is structured. */
export interface PortType {
  readonly kind: ValueKind;
  readonly access: Access;
}

/**
 * Whether a value produced on `from` can be consumed by `to`.
 * Structure is always adaptable (the scheduler lifts), so only the value
 * kind is checked; `any` matches both ways.
 */
export function isAssignable(from: PortType, to: PortType): boolean {
  return from.kind === 'any' || to.kind === 'any' || from.kind === to.kind;
}
