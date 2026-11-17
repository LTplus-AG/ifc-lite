/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan step: physical facts in, derivation plan out. Pure and
 * deterministic (facts order). The rules are in `structural-derive-types.ts`.
 */

import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import { vecLen as length } from '../ifc-creator-math.js';
import { plateOpenings } from './structural-opening-section.js';
import { prepareStructuralFace } from './_structural-face.js';
import { curveElementLine, idealisePlate, prismSection, add, sub, scale, dot } from './structural-derive-idealise.js';
import { clusterEnds, joinEnds, SegmentGrid } from './structural-derive-joints.js';
import { bodyBottom, lowestLevelBearings, surfaceAt, type PlannedSurface } from './structural-derive-supports.js';
import {
  DEFAULT_DERIVATION_OPTIONS,
  type MemberLoadBearing,
  type PhysicalElementFact,
  type PlannedCurveMember,
  type PlannedNode,
  type SkippedElement,
  type SkippedOpening,
  type StructuralDerivationFacts,
  type StructuralDerivationOptions,
  type StructuralDerivationPlan,
  type UnconnectedEnd,
  type Vec3,
} from './structural-derive-types.js';

/** Tolerance and reach bounds, metres. Both ends: NaN and absurd values must not fall through. */
const MAX_TOLERANCE = 1;
const MAX_JOINT_REACH = 2;

/** The classes each role is read from; subtypes count as their parent. Literals: this module has no load-time work. */
export const CURVE = ['IfcBeam', 'IfcColumn', 'IfcMember'] as const;
const SURFACE = ['IfcSlab', 'IfcWall'] as const;
const SUPPORT = ['IfcFooting', 'IfcPile'] as const;
const ROLE_CLASSES = [['curve', CURVE], ['surface', SURFACE], ['support', SUPPORT]] as const;
/** Every class the derivation reads, for the facts reader. */
export const DERIVATION_CLASSES: readonly string[] = [...CURVE, ...SURFACE, ...SUPPORT];

export function roleOf(type: string): (typeof ROLE_CLASSES)[number][0] | null {
  const chain = getInheritanceChainAcrossSchemas(type);
  return ROLE_CLASSES.find(([, classes]) => classes.some((c) => chain.includes(c)))?.[0] ?? null;
}

/** Why apply refuses to write beside these analysis models, or null when it would write. Plan and apply share it. */
export function analysisModelRefusal(models: ReadonlyArray<{ expressId: number }>, options: Pick<StructuralDerivationOptions, 'whenAnalysisModelExists'>): string | null {
  if (models.length === 0 || options.whenAnalysisModelExists === 'add') return null;
  return `Structural derivation: the model already has an analysis model (#${models[0].expressId}); `
    + "set whenAnalysisModelExists to 'add' to derive the missing members into a new one";
}

function resolveDerivationOptions(options: StructuralDerivationOptions = {}): Required<StructuralDerivationOptions> {
  const resolved = { ...DEFAULT_DERIVATION_OPTIONS };
  for (const [key, value] of Object.entries(options)) if (value !== undefined) Object.assign(resolved, { [key]: value });
  const { tolerance, whenLoadBearingUnknown, supportType, jointReach, whenAnalysisModelExists } = resolved;
  if (typeof tolerance !== 'number' || !(tolerance > 0 && tolerance <= MAX_TOLERANCE)) {
    throw new Error(`Structural derivation: tolerance must be a number of metres in (0, ${MAX_TOLERANCE}]`);
  }
  if (jointReach !== null && (typeof jointReach !== 'number' || !(jointReach >= 0 && jointReach <= MAX_JOINT_REACH))) {
    throw new Error(`Structural derivation: jointReach must be null or a number of metres in [0, ${MAX_JOINT_REACH}]`);
  }
  if (whenLoadBearingUnknown !== 'include' && whenLoadBearingUnknown !== 'skip') {
    throw new Error("Structural derivation: whenLoadBearingUnknown must be 'include' or 'skip'");
  }
  if (supportType !== 'pinned' && supportType !== 'fixed') {
    throw new Error("Structural derivation: supportType must be 'pinned' or 'fixed'");
  }
  if (whenAnalysisModelExists !== 'refuse' && whenAnalysisModelExists !== 'add') {
    throw new Error("Structural derivation: whenAnalysisModelExists must be 'refuse' or 'add'");
  }
  return resolved;
}

interface Line { element: PhysicalElementFact; start: Vec3; end: Vec3; axis: [Vec3, Vec3]; section: number | null; source: PlannedCurveMember['axisSource']; loadBearing: MemberLoadBearing }

/** The surface builder's own boundary checks, run here so apply never meets them. */
function checkFace(boundary: Vec3[]): { face: ReturnType<typeof prepareStructuralFace> } | { issue: string } {
  try {
    return { face: prepareStructuralFace(boundary) };
  } catch (error) {
    return { issue: error instanceof Error ? error.message : String(error) };
  }
}

/** A curve element's axis line, or why it has none. */
function lineOf(element: PhysicalElementFact): Omit<Line, 'element' | 'loadBearing'> | { issue: string } {
  const line = curveElementLine(element);
  return 'issue' in line ? line : { start: line.start, end: line.end, axis: [line.start, line.end], section: element.prism ? prismSection(element.prism) : null, source: line.source };
}

export function planStructuralDerivation(facts: StructuralDerivationFacts, options: StructuralDerivationOptions = {}): StructuralDerivationPlan {
  const resolved = resolveDerivationOptions(options);
  const { tolerance } = resolved;
  const isLong = (line: { start: Vec3; end: Vec3 }) => length(sub(line.end, line.start)) > tolerance;
  const skipped: SkippedElement[] = [];
  const skippedOpenings: SkippedOpening[] = [];
  const skip = (element: PhysicalElementFact, reason: SkippedElement['reason'], detail: string) => {
    skipped.push({ elementId: element.expressId, type: element.type, name: element.name, reason, detail });
  };

  const lines: Line[] = [];
  const surfaces: PlannedSurface[] = [];
  const footings: Array<{ element: PhysicalElementFact; min: Vec3; max: Vec3 }> = [];
  // The load-bearing curve members idealised before: part of the structure, not of this plan. They set the
  // lowest level when drawn lower, and a column among them still bears the run it rises from.
  const idealisedLines: Array<{ start: Vec3; end: Vec3; section: number | null }> = [];
  const idealisedSurfaceElements: PhysicalElementFact[] = [];
  /** A surface member on the plate's mid-plane, or why it has none. Openings it cannot carry go to `skippedTo`. */
  const surfaceOf = (element: PhysicalElementFact, loadBearing: MemberLoadBearing, skippedTo: SkippedOpening[]): PlannedSurface | { issue: string } => {
    const plate = element.prism ? idealisePlate(element.prism) : { issue: element.shapeIssue ?? 'no extruded shape' };
    if ('issue' in plate) return plate;
    const face = checkFace(plate.boundary);
    if ('issue' in face) return face;
    return { member: { elementId: element.expressId, storeyId: element.storeyId, ...plate, openings: plateOpenings(element, plate, face.face, tolerance, skippedTo), loadBearing }, normal: face.face.axis };
  };
  for (const element of facts.elements) {
    const role = roleOf(element.type);
    if (role === null) continue;
    if (role === 'support') {
      if (element.bounds) footings.push({ element, ...element.bounds });
      else skip(element, 'no-idealisable-shape', element.shapeIssue ?? 'no readable body');
      continue;
    }
    const line = role === 'curve' ? lineOf(element) : null;
    if (element.idealised && element.loadBearing !== false && line && !('issue' in line) && isLong(line)) {
      idealisedLines.push(line);
    }
    // A wall or slab derived before still holds a run that rests on it.
    if (element.idealised && element.loadBearing !== false && role === 'surface') idealisedSurfaceElements.push(element);
    if (element.idealised) { skip(element, 'already-idealised', 'a structural item is already linked to this element'); continue; }
    if (element.loadBearing === false) { skip(element, 'not-load-bearing', 'LoadBearing is false'); continue; }
    if (element.loadBearing === null && resolved.whenLoadBearingUnknown === 'skip') {
      skip(element, 'load-bearing-unknown', 'no LoadBearing value, and whenLoadBearingUnknown is skip');
      continue;
    }
    const loadBearing: MemberLoadBearing = element.loadBearing === true ? true : 'assumed';
    if (line) {
      if ('issue' in line) skip(element, 'no-idealisable-shape', line.issue);
      else lines.push({ element, ...line, loadBearing });
      continue;
    }
    const surface = surfaceOf(element, loadBearing, skippedOpenings);
    if ('issue' in surface) skip(element, 'no-idealisable-shape', surface.issue);
    else surfaces.push(surface);
  }

  const footingGrid = new SegmentGrid(2);
  footings.forEach(({ min, max }, i) => footingGrid.insert(i, min, max, tolerance));
  /** The first footing in facts order whose bounds, grown by the tolerance, hold the point. */
  const inFooting = (p: Vec3) => {
    let first: number | undefined;
    for (const i of footingGrid.near(p)) {
      const { min, max } = footings[i];
      if ((first === undefined || i < first) && p.every((v, k) => v >= min[k] - tolerance && v <= max[k] + tolerance)) first = i;
    }
    return first === undefined ? undefined : footings[first];
  };
  const long = lines.filter((line) => {
    if (isLong(line)) return true;
    skip(line.element, 'shorter-than-tolerance', `shorter than the ${tolerance} m tolerance`);
    return false;
  });
  // Joints: free ends meet other members' axes; members met inside are split into pieces.
  const joined = joinEnds(long.map((line) => ({ elementId: line.element.expressId, start: line.start, end: line.end, section: line.section })),
    tolerance, resolved.jointReach, (p) => inFooting(p) !== undefined);
  const allRoots = clusterEnds(joined.pieces.flatMap((piece) => [piece.start, piece.end]), tolerance);
  // A piece whose two ends merge is dropped; the clusters stay as they are, so its neighbours stay joined.
  const pieces: Line[] = [];
  const roots: number[] = [];
  joined.pieces.forEach((piece, i) => {
    if (allRoots[2 * i] === allRoots[2 * i + 1]) return;
    pieces.push({ ...long[piece.source], start: piece.start, end: piece.end });
    roots.push(allRoots[2 * i], allRoots[2 * i + 1]);
  });
  const remaining = new Set(pieces.map((piece) => piece.element));
  for (const source of new Set(joined.pieces.map((piece) => piece.source))) {
    if (!remaining.has(long[source].element)) skip(long[source].element, 'shorter-than-tolerance', 'both ends merge into one node');
  }
  // Gather each cluster's ends, then build its node once, at their mean.
  const clusters = new Map<number, { ends: Vec3[]; first: PhysicalElementFact; elementIds: Set<number> }>();
  roots.forEach((root, endIndex) => {
    const piece = pieces[endIndex >> 1];
    const cluster = clusters.get(root) ?? { ends: [], first: piece.element, elementIds: new Set<number>() };
    cluster.ends.push(endIndex % 2 === 0 ? piece.start : piece.end);
    cluster.elementIds.add(piece.element.expressId);
    clusters.set(root, cluster);
  });
  const nodeOfRoot = new Map<number, number>();
  const nodes: PlannedNode[] = [...clusters].map(([root, { ends, first, elementIds }], index) => {
    nodeOfRoot.set(root, index);
    return { index, position: scale(ends.reduce(add), 1 / ends.length), storeyId: first.storeyId, elementIds: [...elementIds] };
  });
  const curveMembers: PlannedCurveMember[] = pieces.map((piece, i) => {
    const startNode = nodeOfRoot.get(roots[2 * i])!;
    const endNode = nodeOfRoot.get(roots[2 * i + 1])!;
    return {
      elementId: piece.element.expressId, storeyId: piece.element.storeyId,
      start: [...nodes[startNode].position], end: [...nodes[endNode].position],
      axisSource: piece.source, physicalAxis: [[...piece.axis[0]], [...piece.axis[1]]], startNode, endNode, loadBearing: piece.loadBearing,
    };
  });

  // Supports: footings first; by elevation only when no footing carries a node.
  const supportType = resolved.supportType;
  const usedFootings = new Set<number>();
  for (const node of nodes) {
    const footing = inFooting(node.position);
    if (!footing) continue;
    usedFootings.add(footing.element.expressId);
    node.support = { type: supportType, basis: 'footing', footingId: footing.element.expressId, guessed: false };
  }
  for (const { element } of footings) {
    if (!usedFootings.has(element.expressId)) skip(element, 'footing-without-member-end', 'no member end lies within its bounds');
  }
  if (usedFootings.size === 0 && nodes.length > 0) {
    // The lowest node after the joints, or a lower member idealised before.
    const idealisedLowest = idealisedLines.reduce((low, line) => Math.min(low, line.start[2], line.end[2]), Infinity);
    const structureLowest = nodes.reduce((low, node) => Math.min(low, node.position[2]), idealisedLowest);
    // Only their openings, not the skips, matter for bearing.
    const idealisedSurfaces = idealisedSurfaceElements.map((element) => surfaceOf(element, 'assumed', []))
      .filter((surface): surface is PlannedSurface => !('issue' in surface));
    const bearings = lowestLevelBearings(nodes, curveMembers.map((member, i) => ({ member, drawn: pieces[i].axis, bottom: bodyBottom(pieces[i].element) })), {
      idealised: idealisedLines, surfaces: [...surfaces, ...idealisedSurfaces], footings, level: structureLowest, tolerance, jointReach: resolved.jointReach,
    });
    for (const index of bearings) {
      nodes[index].support = { type: supportType, basis: 'lowest-level', guessed: true };
    }
  }

  const degree = new Array<number>(nodes.length).fill(0);
  for (const member of curveMembers) { degree[member.startNode]++; degree[member.endNode]++; }
  const freeEnds = nodes.filter((node) => degree[node.index] === 1 && !node.support).map((node) => node.index);
  const surfaceMembers = surfaces.map(({ member }) => member);
  const unconnectedEnds = findUnconnectedEnds(nodes, degree, curveMembers, surfaces, tolerance);
  const guessedSupports = nodes.filter((node) => node.support?.guessed).map((node) => node.index);
  const members = [...curveMembers, ...surfaceMembers];
  return {
    options: resolved,
    defaultStoreyId: facts.defaultStoreyId,
    existingAnalysisModels: facts.existingAnalysisModels,
    refusal: members.length > 0 ? analysisModelRefusal(facts.existingAnalysisModels, resolved) : null,
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
        // Elements, not pieces: a split member counts once.
        assumedLoadBearing: new Set(members.filter((member) => member.loadBearing === 'assumed').map((member) => member.elementId)).size,
        skipped: skipped.length,
        skippedOpenings: skippedOpenings.length,
        extendedEnds: joined.extended.length,
        freeEnds: freeEnds.length,
      },
      skipped,
      skippedOpenings,
      guessedSupports,
      extendedEnds: joined.extended,
      freeEnds,
      unconnectedEnds,
    },
  };
}

/** Nodes that touch a member they are not connected to or, for a single free end, rest on a surface member. */
function findUnconnectedEnds(
  nodes: PlannedNode[],
  degree: readonly number[],
  curveMembers: PlannedCurveMember[],
  surfaces: readonly PlannedSurface[],
  tolerance: number,
): UnconnectedEnd[] {
  const grid = new SegmentGrid(2);
  curveMembers.forEach((member, i) => grid.insert(i, member.start, member.end, tolerance));
  const found: UnconnectedEnd[] = [];
  for (const node of nodes) {
    if (node.support) continue;
    const p = node.position;
    const onMember = grid.near(p).map((i) => curveMembers[i]).find((member) => {
      if (member.startNode === node.index || member.endNode === node.index) return false;
      const axis = sub(member.end, member.start);
      const t = dot(sub(p, member.start), axis) / dot(axis, axis);
      return t > 0 && t < 1 && length(sub(p, add(member.start, scale(axis, t)))) <= tolerance;
    });
    if (onMember) { found.push({ node: node.index, landsOnElementId: onMember.elementId, landsOn: 'member-interior' }); continue; }
    if (degree[node.index] !== 1) continue;
    const onSurface = surfaceAt(p, surfaces, tolerance);
    if (onSurface) found.push({ node: node.index, landsOnElementId: onSurface.member.elementId, landsOn: 'surface-member' });
  }
  return found;
}
