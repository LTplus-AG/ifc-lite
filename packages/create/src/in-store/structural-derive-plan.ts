/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan step: physical facts in, derivation plan out. Pure and
 * deterministic (facts order). The rules are in `structural-derive-types.ts`.
 */

import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import { vecLen as length } from '../ifc-creator-math.js';
import { prepareStructuralFace } from './_structural-face.js';
import { pointInPolygon } from './room-footprint-offset.js';
import { idealiseLine, idealisePlate, add, sub, scale, dot } from './structural-derive-idealise.js';
import {
  DEFAULT_DERIVATION_OPTIONS,
  type MemberLoadBearing,
  type PhysicalElementFact,
  type PlannedCurveMember,
  type PlannedNode,
  type PlannedSurfaceMember,
  type SkippedElement,
  type StructuralDerivationFacts,
  type StructuralDerivationOptions,
  type StructuralDerivationPlan,
  type UnconnectedEnd,
  type Vec3,
} from './structural-derive-types.js';

/** Tolerance bounds, metres. Both ends: NaN and absurd values must not fall through. */
const MAX_TOLERANCE = 1;

/** The class each role is read from; subtypes count as their parent. */
const ROLE_CLASSES = [['curve', ['IfcBeam', 'IfcColumn', 'IfcMember']], ['surface', ['IfcSlab', 'IfcWall']], ['support', ['IfcFooting', 'IfcPile']]] as const;
/** Every class the derivation reads, for the facts reader. */
export const DERIVATION_CLASSES: readonly string[] = ROLE_CLASSES.flatMap(([, classes]) => classes);

function roleOf(type: string): (typeof ROLE_CLASSES)[number][0] | null {
  const chain = getInheritanceChainAcrossSchemas(type);
  return ROLE_CLASSES.find(([, classes]) => classes.some((c) => chain.includes(c)))?.[0] ?? null;
}

function resolveDerivationOptions(options: StructuralDerivationOptions = {}): Required<StructuralDerivationOptions> {
  const resolved = { ...DEFAULT_DERIVATION_OPTIONS };
  for (const [key, value] of Object.entries(options)) if (value !== undefined) Object.assign(resolved, { [key]: value });
  const { tolerance, whenLoadBearingUnknown, supportType } = resolved;
  if (typeof tolerance !== 'number' || !(tolerance > 0 && tolerance <= MAX_TOLERANCE)) {
    throw new Error(`Structural derivation: tolerance must be a number of metres in (0, ${MAX_TOLERANCE}]`);
  }
  if (whenLoadBearingUnknown !== 'include' && whenLoadBearingUnknown !== 'skip') {
    throw new Error("Structural derivation: whenLoadBearingUnknown must be 'include' or 'skip'");
  }
  if (supportType !== 'pinned' && supportType !== 'fixed') {
    throw new Error("Structural derivation: supportType must be 'pinned' or 'fixed'");
  }
  return resolved;
}

interface Line { element: PhysicalElementFact; start: Vec3; end: Vec3; source: PlannedCurveMember['axisSource']; loadBearing: MemberLoadBearing }

/** Union-find over member ends, bucketed on a `tolerance` grid. */
function clusterEnds(points: Vec3[], tolerance: number): number[] {
  const parent = points.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const cell = (p: Vec3) => p.map((v) => Math.floor(v / tolerance));
  const grid = new Map<string, number[]>();
  points.forEach((p, i) => {
    const [x, y, z] = cell(p);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(`${x + dx},${y + dy},${z + dz}`) ?? []) {
        if (length(sub(p, points[j])) <= tolerance) parent[find(i)] = find(j);
      }
    }
    const key = `${x},${y},${z}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  });
  return points.map((_, i) => find(i));
}

/** Point inside a planar polygon, in the plane's dominant projection. */
function insidePolygon(p: Vec3, polygon: Vec3[], normal: Vec3): boolean {
  const drop = [0, 1, 2].reduce((m, k) => (Math.abs(normal[k]) > Math.abs(normal[m]) ? k : m), 0);
  const [i, j] = [0, 1, 2].filter((k) => k !== drop);
  return pointInPolygon(p[i], p[j], polygon.map((q) => [q[i], q[j]]));
}

/** The surface builder's own boundary checks, run here so apply never meets them. */
function checkFace(boundary: Vec3[]): { normal: Vec3 } | { issue: string } {
  try {
    return { normal: prepareStructuralFace(boundary).axis };
  } catch (error) {
    return { issue: error instanceof Error ? error.message : String(error) };
  }
}

export function planStructuralDerivation(facts: StructuralDerivationFacts, options: StructuralDerivationOptions = {}): StructuralDerivationPlan {
  const resolved = resolveDerivationOptions(options);
  const { tolerance } = resolved;
  const skipped: SkippedElement[] = [];
  const skip = (element: PhysicalElementFact, reason: SkippedElement['reason'], detail: string) => {
    skipped.push({ elementId: element.expressId, type: element.type, name: element.name, reason, detail });
  };

  const lines: Line[] = [];
  const surfaces: Array<{ member: PlannedSurfaceMember; normal: Vec3 }> = [];
  const footings: Array<{ element: PhysicalElementFact; min: Vec3; max: Vec3 }> = [];
  for (const element of facts.elements) {
    const role = roleOf(element.type);
    if (role === null) continue;
    if (role === 'support') {
      if (element.bounds) footings.push({ element, ...element.bounds });
      else skip(element, 'no-idealisable-shape', element.shapeIssue ?? 'no readable body');
      continue;
    }
    if (element.idealised) { skip(element, 'already-idealised', 'a structural item is already linked to this element'); continue; }
    if (element.loadBearing === false) { skip(element, 'not-load-bearing', 'LoadBearing is false'); continue; }
    if (element.loadBearing === null && resolved.whenLoadBearingUnknown === 'skip') {
      skip(element, 'load-bearing-unknown', 'no LoadBearing value, and whenLoadBearingUnknown is skip');
      continue;
    }
    const loadBearing: MemberLoadBearing = element.loadBearing === true ? true : 'assumed';
    if (role === 'curve') {
      if (element.axis) {
        lines.push({ element, start: element.axis[0], end: element.axis[1], source: 'axis', loadBearing });
        continue;
      }
      const line = element.prism ? idealiseLine(element.prism) : { issue: element.shapeIssue ?? 'no extruded shape' };
      if ('issue' in line) skip(element, 'no-idealisable-shape', line.issue);
      else lines.push({ element, start: line.start, end: line.end, source: line.source, loadBearing });
      continue;
    }
    const plate = element.prism ? idealisePlate(element.prism) : { issue: element.shapeIssue ?? 'no extruded shape' };
    if ('issue' in plate) { skip(element, 'no-idealisable-shape', plate.issue); continue; }
    const face = checkFace(plate.boundary);
    if ('issue' in face) skip(element, 'no-idealisable-shape', face.issue);
    else surfaces.push({ member: { elementId: element.expressId, storeyId: element.storeyId, ...plate, loadBearing }, normal: face.normal });
  }

  // Nodes: a member whose ends would merge is skipped before and after clustering.
  let kept = lines.filter((line) => {
    if (length(sub(line.end, line.start)) > tolerance) return true;
    skip(line.element, 'shorter-than-tolerance', `shorter than the ${tolerance} m tolerance`);
    return false;
  });
  let roots = clusterEnds(kept.flatMap((line) => [line.start, line.end]), tolerance);
  const collapsed = new Set(kept.map((_, i) => i).filter((i) => roots[2 * i] === roots[2 * i + 1]));
  if (collapsed.size > 0) {
    for (const i of collapsed) skip(kept[i].element, 'shorter-than-tolerance', 'both ends merge into one node');
    kept = kept.filter((_, i) => !collapsed.has(i));
    roots = clusterEnds(kept.flatMap((line) => [line.start, line.end]), tolerance);
  }
  // Gather each cluster's ends, then build its node once, at their mean.
  const clusters = new Map<number, { ends: Vec3[]; first: PhysicalElementFact; elementIds: Set<number> }>();
  roots.forEach((root, endIndex) => {
    const line = kept[endIndex >> 1];
    const cluster = clusters.get(root) ?? { ends: [], first: line.element, elementIds: new Set<number>() };
    cluster.ends.push(endIndex % 2 === 0 ? line.start : line.end);
    cluster.elementIds.add(line.element.expressId);
    clusters.set(root, cluster);
  });
  const nodeOfRoot = new Map<number, number>();
  const nodes: PlannedNode[] = [...clusters].map(([root, { ends, first, elementIds }], index) => {
    nodeOfRoot.set(root, index);
    return { index, position: scale(ends.reduce(add), 1 / ends.length), storeyId: first.storeyId, elementIds: [...elementIds] };
  });
  const curveMembers: PlannedCurveMember[] = kept.map((line, i) => {
    const startNode = nodeOfRoot.get(roots[2 * i])!;
    const endNode = nodeOfRoot.get(roots[2 * i + 1])!;
    return {
      elementId: line.element.expressId, storeyId: line.element.storeyId,
      start: [...nodes[startNode].position], end: [...nodes[endNode].position],
      axisSource: line.source, startNode, endNode, loadBearing: line.loadBearing,
    };
  });

  // Supports: footings first; by elevation only when no footing carries a node.
  const supportType = resolved.supportType;
  const usedFootings = new Set<number>();
  for (const node of nodes) {
    const footing = footings.find(({ min, max }) => node.position.every((v, k) => v >= min[k] - tolerance && v <= max[k] + tolerance));
    if (!footing) continue;
    usedFootings.add(footing.element.expressId);
    node.support = { type: supportType, basis: 'footing', footingId: footing.element.expressId, guessed: false };
  }
  for (const { element } of footings) {
    if (!usedFootings.has(element.expressId)) skip(element, 'footing-without-member-end', 'no member end lies within its bounds');
  }
  if (usedFootings.size === 0 && nodes.length > 0) {
    const lowest = Math.min(...nodes.map((node) => node.position[2]));
    for (const node of nodes) {
      if (node.position[2] <= lowest + tolerance) node.support = { type: supportType, basis: 'lowest-level', guessed: true };
    }
  }

  const surfaceMembers = surfaces.map(({ member }) => member);
  const unconnectedEnds = findUnconnectedEnds(nodes, curveMembers, surfaces, tolerance);
  const guessedSupports = nodes.filter((node) => node.support?.guessed).map((node) => node.index);
  const members = [...curveMembers, ...surfaceMembers];
  return {
    options: resolved,
    defaultStoreyId: facts.defaultStoreyId,
    curveMembers,
    surfaceMembers,
    nodes,
    report: {
      counts: {
        curveMembers: curveMembers.length,
        surfaceMembers: surfaceMembers.length,
        nodes: nodes.length,
        supports: nodes.filter((node) => node.support).length,
        guessedSupports: guessedSupports.length,
        assumedLoadBearing: members.filter((member) => member.loadBearing === 'assumed').length,
        skipped: skipped.length,
      },
      skipped,
      guessedSupports,
      unconnectedEnds,
    },
  };
}

/** Free member ends that touch another member's interior or a surface member: reported, not connected. */
function findUnconnectedEnds(
  nodes: PlannedNode[],
  curveMembers: PlannedCurveMember[],
  surfaces: Array<{ member: PlannedSurfaceMember; normal: Vec3 }>,
  tolerance: number,
): UnconnectedEnd[] {
  const degree = new Array<number>(nodes.length).fill(0);
  for (const member of curveMembers) { degree[member.startNode]++; degree[member.endNode]++; }
  const found: UnconnectedEnd[] = [];
  for (const node of nodes) {
    if (degree[node.index] !== 1 || node.support) continue;
    const p = node.position;
    const onMember = curveMembers.find((member) => {
      if (member.startNode === node.index || member.endNode === node.index) return false;
      const axis = sub(member.end, member.start);
      const t = dot(sub(p, member.start), axis) / dot(axis, axis);
      return t > 0 && t < 1 && length(sub(p, add(member.start, scale(axis, t)))) <= tolerance;
    });
    if (onMember) { found.push({ node: node.index, landsOnElementId: onMember.elementId, landsOn: 'member-interior' }); continue; }
    const onSurface = surfaces.find(({ member, normal }) =>
      Math.abs(dot(sub(p, member.boundary[0]), normal)) <= tolerance + member.thickness / 2 && insidePolygon(p, member.boundary, normal));
    if (onSurface) found.push({ node: node.index, landsOnElementId: onSurface.member.elementId, landsOn: 'surface-member' });
  }
  return found;
}
