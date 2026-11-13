/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolveAppearance, type Appearance, type AppearanceTables, type Look } from './appearance.js';
import { cost, type BlockMeshes, type DrawnPart, type Emitter } from './emit.js';
import type { Part } from './geometry.js';
import { plural, type Report } from './report.js';
import type { RhinoRgba } from './types.js';
import { isUsable, multiply, reach, type Xform } from './xform.js';

export interface BlockMember { part: Part; look: Look; hidden: boolean }

/** One instance definition, split into what the walk needs. */
export interface Block extends BlockMeshes {
  /** A linked definition's geometry lives in another file. */
  linked: boolean;
  /**
   * Curves and point clouds, and the meshes no definition colour can carry, which `memberColor`
   * names: always baked, and charged to the budget per placement.
   */
  others: { part: Exclude<DrawnPart, { kind: 'dot' }>; look: Look }[];
  /** Text dots: always baked, and counted against their own limit. */
  dots: { part: Extract<Part, { kind: 'dot' }>; look: Look }[];
  nested: { part: Extract<Part, { kind: 'instance' }>; look: Look }[];
  /** A placement can draw a text dot, this block's own or a nested block's. Set by `markContents`. */
  drawsDots: boolean;
  /** The same for meshes, curves and point clouds. */
  drawsGeometry: boolean;
}

/** Most block references one file's walk may reach, drawn or skipped; bounds a fan-out that no triangle budget sees. */
export const MAX_BLOCK_PLACEMENTS = 500_000;

/**
 * Whether any material a block instance can hand down to a member that inherits one is
 * transparent, which is what decides whether such a member can be drawn from the shared
 * definition. Measured over the materials the file's instances resolve to, not over the material
 * table: a Rhino file keeps materials nothing references, and one leftover transparent material
 * would otherwise bake every inheriting member in the file. An instance that takes its material
 * from its own parent takes another instance's, so these cover the nested cases too.
 */
export function inheritableFade(objects: Iterable<{ part: Part; appearance: Appearance }>, tables: AppearanceTables): boolean {
  for (const { part, appearance } of objects) {
    if (part.kind === 'instance' && (tables.materials[appearance.material]?.transparency ?? 0) > 0) return true;
  }
  return false;
}

/** What every definition in one file is built against, so `buildBlock` takes the per-definition part alone. */
export interface BlockContext {
  tables: AppearanceTables;
  /** From `inheritableFade`, measured once for the file. */
  fades: boolean;
  report: Report;
}

/** An opaque colour and no material: resolving against it reflects only the member's own attributes. */
const NEUTRAL_PARENT: Appearance = { color: [0, 0, 0, 1], material: -1 };

/**
 * What colour a member's mesh can carry inside the shared definition every instance places:
 *
 * - a colour, when it is the same under every instance;
 * - `'instance'`, when it is exactly the placing instance's resolved colour, which the instance
 *   record carries, so the definition mesh leaves it open as `null`;
 * - `'bake'`, when it is neither, and the mesh is drawn once per placement. That is a colour the
 *   instance's material decides, and the instance's colour at the member's own alpha.
 *
 * An inherited material can only change a member's colour through its diffuse colour or its
 * transparency, so a member that does not read that diffuse needs baking only where something can
 * fade it, which is what `fades` says.
 */
function memberColor(look: Look, { tables, fades }: BlockContext): RhinoRgba | 'instance' | 'bake' {
  // Against a parent that contributes nothing, so an alpha below 1 is the member's own material's,
  // and a colour inherited along with the material comes back opaque: exactly the instance's.
  const own = resolveAppearance(look, tables, NEUTRAL_PARENT).color;
  if (look.colorSource === 'parent') return own[3] < 1 ? 'bake' : 'instance';
  if (look.materialSource === 'parent' && (look.colorSource === 'material' || fades)) return 'bake';
  return own;
}

export function buildBlock(name: string, linked: boolean, members: BlockMember[], context: BlockContext): Block {
  const block: Block = { name, linked, meshes: [], cost: 0, reach: [0, 0, 0], others: [], dots: [], nested: [], drawsDots: false, drawsGeometry: false };
  for (const { part, look, hidden } of members) {
    // Rhino does not draw a member that is hidden or on a layer that is off, in any instance.
    if (hidden) context.report.skip('hidden-block-member');
    else if (part.kind === 'instance') block.nested.push({ part, look });
    else if (part.kind === 'dot') block.dots.push({ part, look });
    else if (part.kind !== 'mesh') block.others.push({ part, look });
    else {
      const color = memberColor(look, context);
      if (color === 'bake') block.others.push({ part, look });
      else {
        block.meshes.push({ origin: part.origin, positions: part.positions, normals: part.normals, indices: part.indices, color: color === 'instance' ? null : color });
        block.cost += cost(part);
        reach(part.positions).forEach((extent, axis) => { block.reach[axis] = Math.max(block.reach[axis], Math.abs(part.origin[axis]) + extent); });
      }
    }
  }
  return block;
}

/**
 * Mark what a placement of each block can draw, itself or through a nested block, so the walk
 * knows past the triangle budget which branches still hold dots and which lose geometry.
 */
export function markContents(blocks: Map<string, Block>): void {
  const parents = new Map<string, string[]>();
  for (const [id, block] of blocks) for (const { part } of block.nested) {
    const list = parents.get(part.definition);
    if (list) list.push(id); else parents.set(part.definition, [id]);
  }
  const spread = (flag: 'drawsDots' | 'drawsGeometry', holds: (block: Block) => boolean) => {
    const queue = Array.from(blocks).filter(([, block]) => holds(block)).map(([id]) => id);
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      const block = blocks.get(id)!;
      if (block[flag]) continue;
      block[flag] = true;
      // One push per parent: a spread passes them as arguments, and a definition placed by enough blocks overflows the stack.
      for (const parent of parents.get(id) ?? []) queue.push(parent);
    }
  };
  spread('drawsDots', block => block.dots.length > 0);
  spread('drawsGeometry', block => block.meshes.length + block.others.length > 0);
}

export interface BlockWalk {
  blocks: Map<string, Block>;
  tables: AppearanceTables;
  emitter: Emitter;
  report: Report;
  /** Block references the walk may still reach, for the whole file. */
  placementsLeft: number;
}

/**
 * Expand one top-level instance into placements of block meshes, flattening
 * nested blocks into composed transforms. Returns false when a budget left
 * part of it out, so the caller can count the object as not drawn. The
 * placement budget ends the walk. The triangle budget ends only the branches
 * that lead to no text dot, because dots are free of it and are still drawn.
 *
 * The walk is iterative. Its visited set is path-scoped (added on the way in,
 * removed on the way out) because geometry accumulates: one block reached
 * down two branches is two real copies, while a block inside itself is a
 * cycle, which is skipped and counted. `placementsLeft` is the work budget, charged for
 * every reference reached, so one that is skipped costs as much as one drawn, and for
 * every part a placement pushes out of range.
 */
export function expandInstance(walk: BlockWalk, object: number, id: string, xform: Xform, appearance: Appearance): boolean {
  const { blocks, tables, emitter, report } = walk;
  type Frame = { id: string; leave: true } | { id: string; leave: false; xform: Xform; appearance: Appearance };
  const stack: Frame[] = [{ id, leave: false, xform, appearance }];
  const path = new Set<string>();
  let complete = true;
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    if (frame.leave) { path.delete(frame.id); continue; }
    // Charged before the skip below, which still names its own reason once the budget is spent.
    --walk.placementsLeft;
    const block = blocks.get(frame.id);
    const skip = !block ? 'InstanceReference:missing-definition'
      : block.linked && block.meshes.length + block.others.length + block.dots.length + block.nested.length === 0 ? 'InstanceReference:linked-definition'
      : path.has(frame.id) ? 'InstanceReference:cycle'
      : !isUsable(frame.xform) ? 'InstanceReference:invalid' : null;
    if (skip) {
      report.skip(skip);
      if (skip === 'InstanceReference:linked-definition') report.warn('linked', n => `${plural(n, 'instance')} of linked blocks are not drawn: their geometry is in another file.`);
      if (skip === 'InstanceReference:cycle') report.warn('cycle', n => `${plural(n, 'block reference')} point back into their own definition and are skipped.`);
    }
    // Checked on every reference, drawn or skipped: a block holding nothing but references the walk
    // skips would otherwise never reach it, and the whole batch was expanded with no warning.
    if (walk.placementsLeft < 0) {
      report.warn('placements', () => `Stopped expanding blocks after ${MAX_BLOCK_PLACEMENTS.toLocaleString('en-US')} block references.`);
      // A reference the budget stops at had its own reason, and at the top of a walk nothing was
      // left to expand, so it keeps that reason rather than also counting as undrawn. Anywhere
      // inside a block the placement was cut short, whichever reference spent the last of it.
      if (!skip || stack.length > 0) complete = false;
      return complete;
    }
    if (!block || skip) continue;
    // Past the triangle budget only text dots are drawn, so a block that leads to none ends its branch.
    if (emitter.exhausted && !block.drawsDots) { complete &&= !block.drawsGeometry; continue; }
    const { xform, appearance } = frame, outOfRange = emitter.outOfRange;
    if (!(emitter.place(object, frame.id, block, xform, appearance.color)
      && block.others.every(({ part, look }) => emitter.draw(object, part, xform, resolveAppearance(look, tables, appearance).color)))) complete = false;
    // A part left out as out of range draws nothing and costs no triangles, so it is charged here like a reference.
    walk.placementsLeft -= emitter.outOfRange - outOfRange;
    // Past the limit a placement's dots are counted in one step, so they cost the walk nothing.
    if (emitter.dotsFull()) emitter.omitDots(block.dots.length);
    else for (const { part, look } of block.dots) emitter.draw(object, part, xform, resolveAppearance(look, tables, appearance).color);
    path.add(frame.id);
    stack.push({ id: frame.id, leave: true });
    for (let i = block.nested.length - 1; i >= 0; i--) {
      const { part, look } = block.nested[i];
      stack.push({ id: part.definition, leave: false, xform: multiply(xform, part.xform), appearance: resolveAppearance(look, tables, appearance) });
    }
  }
  return complete;
}
