/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan step: physical facts in, derivation plan out. Pure and
 * deterministic (facts order). The rules are in `structural-derive-types.ts`.
 */

import { prepareStructuralFace } from './_structural-face.js';
import { idealiseLine, idealisePlate, prismBounds, add, sub, scale, dot, cross, length } from './structural-derive-idealise.js';
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

export function resolveDerivationOptions(options: StructuralDerivationOptions = {}): Required<StructuralDerivationOptions> {
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
    grid.set(key, [...(grid.get(key) ?? []), i]);
  });
  return points.map((_, i) => find(i));
}

/** Point inside a planar polygon, tested in the plane's dominant projection. */
function insidePolygon(p: Vec3, polygon: Vec3[], normal: Vec3): boolean {
  const drop = [0, 1, 2].reduce((m, k) => (Math.abs(normal[k]) > Math.abs(normal[m]) ? k : m), 0);
  const [i, j] = [0, 1, 2].filter((k) => k !== drop);
  let inside = false;
  for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
    const pa = polygon[a], pb = polygon[b];
    if ((pa[j] > p[j]) !== (pb[j] > p[j]) && p[i] < ((pb[i] - pa[i]) * (p[j] - pa[j])) / (pb[j] - pa[j]) + pa[i]) inside = !inside;
  }
  return inside;
}

/** The surface builder's own boundary checks, run here so apply never meets them. */
function faceRefusal(boundary: Vec3[]): string | null {
  try {
    prepareStructuralFace(boundary);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function planeNormal(polygon: Vec3[]): Vec3 {
  let area: Vec3 = [0, 0, 0];
  for (let i = 1; i + 1 < polygon.length; i++) area = add(area, cross(sub(polygon[i], polygon[0]), sub(polygon[i + 1], polygon[0])));
  return scale(area, 1 / length(area));
}

export function planStructuralDerivation(facts: StructuralDerivationFacts, options: StructuralDerivationOptions = {}): StructuralDerivationPlan {
  const resolved = resolveDerivationOptions(options);
  const { tolerance } = resolved;
  const skipped: SkippedElement[] = [];
  const skip = (element: PhysicalElementFact, reason: SkippedElement['reason'], detail: string) => {
    skipped.push({ elementId: element.expressId, type: element.type, name: element.name, reason, detail });
  };

  const lines: Line[] = [];
  const surfaceMembers: PlannedSurfaceMember[] = [];
  const footings: Array<{ element: PhysicalElementFact; min: Vec3; max: Vec3 }> = [];
  for (const element of facts.elements) {
    if (element.role === 'support') {
      if (element.prism) footings.push({ element, ...prismBounds(element.prism) });
      else skip(element, 'no-idealisable-shape', element.shapeIssue ?? 'no extruded shape');
      continue;
    }
    if (element.idealised) { skip(element, 'already-idealised', 'a structural item is already linked to this element'); continue; }
    if (element.loadBearing === false) { skip(element, 'not-load-bearing', 'LoadBearing is false'); continue; }
    if (element.loadBearing === null && resolved.whenLoadBearingUnknown === 'skip') {
      skip(element, 'load-bearing-unknown', 'no LoadBearing value, and whenLoadBearingUnknown is skip');
      continue;
    }
    const loadBearing: MemberLoadBearing = element.loadBearing === true ? true : 'assumed';
    if (element.role === 'curve') {
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
    const faceIssue = 'issue' in plate ? plate.issue : faceRefusal(plate.boundary);
    if (faceIssue) skip(element, 'no-idealisable-shape', faceIssue);
    else if (!('issue' in plate)) surfaceMembers.push({ elementId: element.expressId, storeyId: element.storeyId, ...plate, loadBearing });
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
  const nodeOfRoot = new Map<number, number>();
  const ends: Vec3[][] = [];
  const nodes: PlannedNode[] = [];
  roots.forEach((root, endIndex) => {
    const line = kept[endIndex >> 1];
    let index = nodeOfRoot.get(root);
    if (index === undefined) {
      index = nodes.length;
      nodeOfRoot.set(root, index);
      nodes.push({ index, position: [0, 0, 0], storeyId: line.element.storeyId, elementIds: [] });
      ends.push([]);
    }
    ends[index].push(endIndex % 2 === 0 ? line.start : line.end);
    if (!nodes[index].elementIds.includes(line.element.expressId)) nodes[index].elementIds.push(line.element.expressId);
  });
  for (const node of nodes) node.position = scale(ends[node.index].reduce(add), 1 / ends[node.index].length);
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

  const unconnectedEnds = findUnconnectedEnds(nodes, curveMembers, surfaceMembers, tolerance);
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
  surfaceMembers: PlannedSurfaceMember[],
  tolerance: number,
): UnconnectedEnd[] {
  const degree = new Array<number>(nodes.length).fill(0);
  for (const member of curveMembers) { degree[member.startNode]++; degree[member.endNode]++; }
  const planes = surfaceMembers.map((member) => ({ member, normal: planeNormal(member.boundary) }));
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
    const onSurface = planes.find(({ member, normal }) =>
      Math.abs(dot(sub(p, member.boundary[0]), normal)) <= tolerance + member.thickness / 2 && insidePolygon(p, member.boundary, normal));
    if (onSurface) found.push({ node: node.index, landsOnElementId: onSurface.member.elementId, landsOn: 'surface-member' });
  }
  return found;
}
