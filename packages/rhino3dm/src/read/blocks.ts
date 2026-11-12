/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolveAppearance, takesParentColor, type Appearance, type AppearanceTables, type Look } from './appearance.js';
import type { BlockMeshes, DrawnPart, Emitter } from './emit.js';
import type { Part } from './geometry.js';
import { plural, type Report } from './report.js';
import { isUsable, multiply, type Xform } from './xform.js';

export interface BlockMember { part: Part; look: Look; hidden: boolean }

/** Stands in for the placing instance when a member's colour does not depend on it. */
const ANY_PARENT: Appearance = { color: [0, 0, 0, 1], material: -1 };

/** One instance definition, split into what the walk needs. */
export interface Block extends BlockMeshes {
  /** A linked definition's geometry lives in another file. */
  linked: boolean;
  /**
   * Curves and point clouds, and a "by parent" mesh with a transparent material of its own:
   * always baked, and charged to the budget per placement.
   */
  others: { part: Exclude<DrawnPart, { kind: 'dot' }>; look: Look }[];
  /** Text dots: always baked, and counted against their own limit. */
  dots: { part: Extract<Part, { kind: 'dot' }>; look: Look }[];
  nested: { part: Extract<Part, { kind: 'instance' }>; look: Look }[];
}

/** Most block references one file's walk may reach, drawn or skipped; bounds a fan-out that no triangle budget sees. */
export const MAX_BLOCK_PLACEMENTS = 500_000;

export function buildBlock(name: string, linked: boolean, members: BlockMember[], tables: AppearanceTables, report: Report): Block {
  const block: Block = { name, linked, meshes: [], triangles: 0, others: [], dots: [], nested: [] };
  for (const { part, look, hidden } of members) {
    // Rhino does not draw a member that is hidden or on a layer that is off, in any instance.
    if (hidden) report.skip('hidden-block-member');
    else if (part.kind === 'instance') block.nested.push({ part, look });
    else if (part.kind === 'dot') block.dots.push({ part, look });
    else if (part.kind !== 'mesh') block.others.push({ part, look });
    else {
      const byParent = takesParentColor(look), own = resolveAppearance(look, tables, ANY_PARENT).color;
      // A definition mesh holds one colour or none, so it cannot say "the instance's colour at my own alpha".
      if (byParent && own[3] < 1) block.others.push({ part, look });
      else {
        // A "by parent" mesh takes the colour of whichever instance places it.
        block.meshes.push({ origin: part.origin, positions: part.positions, normals: part.normals, indices: part.indices, color: byParent ? null : own });
        block.triangles += part.indices.length / 3;
      }
    }
  }
  return block;
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
 * nested blocks into composed transforms. Returns false when a budget stopped
 * it, so the caller can count the object as not drawn.
 *
 * The walk is iterative. Its visited set is path-scoped (added on the way in,
 * removed on the way out) because geometry accumulates: one block reached
 * down two branches is two real copies, while a block inside itself is a
 * cycle, which is skipped and counted. `placementsLeft` is the work budget, charged for
 * every reference reached, so one that is skipped costs as much as one drawn.
 */
export function expandInstance(walk: BlockWalk, object: number, id: string, xform: Xform, appearance: Appearance): boolean {
  const { blocks, tables, emitter, report } = walk;
  type Frame = { id: string; leave: true } | { id: string; leave: false; xform: Xform; appearance: Appearance };
  const stack: Frame[] = [{ id, leave: false, xform, appearance }];
  const path = new Set<string>();
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    if (frame.leave) { path.delete(frame.id); continue; }
    // Charged before the skips below, which still name their own reason once the budget is spent.
    walk.placementsLeft--;
    const block = blocks.get(frame.id);
    if (!block) { report.skip('InstanceReference:missing-definition'); continue; }
    if (block.linked && block.meshes.length + block.others.length + block.dots.length + block.nested.length === 0) {
      report.skip('InstanceReference:linked-definition');
      report.warn('linked', n => `${plural(n, 'instance')} of linked blocks are not drawn: their geometry is in another file.`);
      continue;
    }
    if (path.has(frame.id)) {
      report.skip('InstanceReference:cycle');
      report.warn('cycle', n => `${plural(n, 'block reference')} point back into their own definition and are skipped.`);
      continue;
    }
    if (!isUsable(frame.xform)) { report.skip('InstanceReference:invalid'); continue; }
    if (walk.placementsLeft < 0) {
      report.warn('placements', () => `Stopped expanding blocks after ${MAX_BLOCK_PLACEMENTS.toLocaleString('en-US')} block references.`);
      return false;
    }
    if (!emitter.place(object, frame.id, block, frame.xform, frame.appearance.color)) return false;
    for (const { part, look } of block.others) {
      if (!emitter.draw(object, part, frame.xform, resolveAppearance(look, tables, frame.appearance).color)) return false;
    }
    // Past the limit a placement's dots are counted in one step, so they cost the walk nothing.
    if (emitter.dotsFull()) emitter.omitDots(block.dots.length);
    else for (const { part, look } of block.dots) emitter.draw(object, part, frame.xform, resolveAppearance(look, tables, frame.appearance).color);
    path.add(frame.id);
    stack.push({ id: frame.id, leave: true });
    for (let i = block.nested.length - 1; i >= 0; i--) {
      const { part, look } = block.nested[i];
      stack.push({ id: part.definition, leave: false, xform: multiply(frame.xform, part.xform), appearance: resolveAppearance(look, tables, frame.appearance) });
    }
  }
  return true;
}
