/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-member draw decisions of the draw stream (`draw-stream.ts`): which
 * members of a node are contribution-culled or drawn at LOD1 this frame,
 * decided per batch exactly like the per-batch loop, the load a mixed node
 * draws, and the bundle cache of its last pick pattern.
 */
import type { BatchedMesh } from './types.js';
import { MemberPick, pxPerMetre, type StreamFrameInputs, type StreamNode } from './draw-stream-types.js';

/** Reused per-member picks while a node is decided (copied out only when its members differ). */
let scratch = new Uint8Array(64);

/**
 * Each member's draw from its OWN projected size, exactly as the per-batch
 * loop decides a batch (contribution cull, then LOD1 below `lodPx`): a node
 * spans a whole chunk cell, so judging it by its own size drew small members
 * at full detail that the loop draws simplified or not at all (#11370
 * qualification: slab edges, glazing). Returns the members' common pick, or
 * one pick per member when they differ.
 */
export function memberPicks(f: StreamFrameInputs, node: StreamNode, members: readonly BatchedMesh[]): MemberPick | Uint8Array {
  if (!(f.contribPx > 0) && !(f.lodPx > 0)) return MemberPick.Lod0;
  // Every member at least `minRadius`, no farther than the node's far corner: when even that projects
  // above both thresholds, all members draw at LOD0 without projecting each (most near nodes).
  const far = Math.sqrt(farDist2(node.min, node.max, f.eye));
  if (node.minRadius * pxPerMetre(f.projection, far) * 0.999 >= Math.max(f.contribPx, f.lodPx)) return MemberPick.Lod0;
  const pickOf = (k: number): MemberPick => {
    const b = members[node.members[k]!]!, px = b.bounds ? f.projectedPx(b.bounds.min, b.bounds.max) : Infinity;
    if (f.contribPx > 0 && px < f.contribPx) return MemberPick.Cull;
    if (!(b.lod1IndexBuffer && b.lod1IndexCount)) return MemberPick.AnyLod;
    return f.lodPx > 0 && px < f.lodPx ? MemberPick.Lod1 : MemberPick.Lod0;
  };
  let common = -1, mixed = false, drawsAny = false;
  if (scratch.length < node.members.length) scratch = new Uint8Array(node.members.length * 2);
  for (let k = 0; k < node.members.length; k++) {
    const s = scratch[k] = pickOf(k);
    if (s === MemberPick.AnyLod) drawsAny = true; // agrees with either LOD, never with Cull
    else if (common < 0) common = s; else if (s !== common) mixed = true;
  }
  if (mixed || (common === MemberPick.Cull && drawsAny)) return scratch.slice(0, node.members.length); // copied only when mixed
  return common < 0 ? MemberPick.Lod0 : common as MemberPick;
}

function farDist2(min: readonly number[], max: readonly number[], p: { x: number; y: number; z: number }): number {
  const dx = Math.max(p.x - min[0]!, max[0]! - p.x), dy = Math.max(p.y - min[1]!, max[1]! - p.y), dz = Math.max(p.z - min[2]!, max[2]! - p.z);
  return dx * dx + dy * dy + dz * dz;
}

/** Draws and triangles of a mixed node this frame (culled members excluded). */
export function pickedLoad(node: StreamNode, picks: Uint8Array, members: readonly BatchedMesh[]): { draws: number; tris: number } {
  let draws = 0, tris = 0;
  for (let k = 0; k < picks.length; k++) {
    if (picks[k] === MemberPick.Cull) continue;
    const b = members[node.members[k]!]!; draws++;
    tris += (picks[k] === MemberPick.Lod1 ? b.lod1IndexCount! : b.indexCount) / 3;
  }
  return { draws, tris };
}

/** The node's cached mixed-LOD bundles when they were recorded under `key` for exactly these picks. */
export function mixedBundles(node: StreamNode, key: string, picks: Uint8Array): GPURenderBundle[] | null {
  const m = node.mixed;
  if (!m || m.key !== key || m.picks.length !== picks.length) return null;
  for (let k = 0; k < picks.length; k++) if (m.picks[k] !== picks[k]) return null;
  return m.bundles;
}
