/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deriving a structural analysis model from a physical one (#9668): the
 * data that crosses each step, and the rules, written down in one place.
 *
 *   readStructuralDerivationFacts(store, editor)  -> StructuralDerivationFacts
 *   planStructuralDerivation(facts, options)      -> StructuralDerivationPlan
 *   applyStructuralDerivation(editor, store, plan) -> StructuralDerivationApplied
 *
 * The plan is plain data. Tests, the CLI and the viewer review all read the
 * same plan; only `apply` writes.
 *
 * RULES
 *
 * Which elements. IfcBeam, IfcColumn and IfcMember become curve members;
 * IfcSlab, IfcWall and IfcWallStandardCase become surface members (the IFC4
 * StandardCase/ElementedCase subtypes of each count as their parent). The
 * plan step decides this from the class; the facts carry only the class.
 * IfcFooting and IfcPile only place supports, by the bounds of their body
 * (any body: extrusions, tessellations, breps). An element is used when its
 * `Pset_*Common.LoadBearing` is true (occurrence first, then its type). When
 * the property is absent, `whenLoadBearingUnknown` decides: 'include' (the
 * default; such members are marked `loadBearing: 'assumed'`) or 'skip'.
 * LoadBearing false is always skipped.
 *
 * Shapes. The facts reader reads one extruded prism per element (an
 * IfcExtrudedAreaSolid, also inside one IfcMappedItem or as the first operand
 * of a boolean clipping), in world metres, plus a straight 2-point Axis
 * representation when there is one. Tessellations, breps, sweeps along
 * curves, several Body items and scaled mapped items are not read; the
 * element is skipped with the reason.
 *
 * Curve members. The Axis representation when present. Otherwise the prism
 * axis: through the centre of the profile's bounds, along the extrusion when
 * the extrusion is the prism's longest side, or along the profile's long side
 * at half depth when the profile is a near-rectangle longer than the
 * extrusion (beams drawn in elevation). Anything else is skipped.
 *
 * Surface members. The prism's mid-plane across its thinnest side: the
 * profile outline moved half the depth along the extrusion when the depth is
 * the thinnest side (slabs), or the profile's centre line swept along the
 * extrusion when the profile is a near-rectangle thinner than the depth
 * (walls). Thickness is that thinnest side. Oblique extrusions and profiles
 * read only as bounds (I-shapes, circles) are skipped. Openings and profile
 * voids are not carried: the surface member covers the outer outline.
 *
 * Joints. Axes run through section centres, so a column top stops below the
 * beam axis and a beam end stops at the column face. Before nodes are formed,
 * a member end that meets nothing (a free end) is moved along its OWN axis,
 * never sideways, to where that axis meets another curve member's axis, if
 * the move is within the reach: `jointReach` metres when set, otherwise half
 * the other member's larger section dimension plus `tolerance` (just
 * `tolerance` when the other member has no readable section); never less
 * than `tolerance`. When the meeting
 * point lies past the other member's free end, that end moves along its own
 * axis to it as well, by the same reach rule. When it lies inside the other
 * member, that member is split there into two curve members, both linked to
 * its element, so the joint is a real node. An end already shared with other
 * members only connects to an interior it already touches (within
 * `tolerance`); it is not moved. Every moved end is in the report
 * (`extendedEnds`) with the distance moved (negative when trimmed).
 *
 * Nodes. Every curve member end is a node. Ends within `tolerance` (metres,
 * default 0.05) of each other merge into one node at their mean, and member
 * ends move onto it. The merge is transitive: a chain of ends, each within
 * the tolerance of the next, becomes one node. A member whose two ends merge
 * is skipped. The report lists every free end left (`freeEnds`: a node with one
 * member end and no support, whatever its distance to anything; cantilever
 * tips are among them), and separately every node that touches a member it is
 * not connected to or, for a single free end, rests on a surface member
 * (`unconnectedEnds`). Surface members get no connections.
 *
 * Supports. A node inside a footing or pile's body bounds (grown by `tolerance`)
 * is a support linked to that footing. When no footing supports any node, the
 * nodes at the lowest level become supports and are flagged `guessed`. The
 * lowest level is the lowest drawn end of the load-bearing curve structure,
 * within `tolerance`: the members this run derives and those already
 * idealised (members longer than `tolerance`; an unknown LoadBearing counts
 * under 'include', or when already idealised), so a partial run never
 * guesses a support under an upper floor. A node the joints moved up from that
 * level (a column foot onto a grade beam axis) is a support too, unless an
 * element meeting at it already has a node on the level. `supportType` is
 * 'pinned' (translations fixed, rotations free; the default) or 'fixed'.
 *
 * Links. Every member and node is linked to the physical elements it
 * idealises with IfcRelAssignsToProduct (the item in RelatedObjects): a member
 * to its element, a node to the elements whose ends meet there and to its
 * footing.
 *
 * Existing analysis models. When the file already has any
 * IfcStructuralAnalysisModel (authored or derived), the plan lists them
 * (`existingAnalysisModels`) and apply refuses, unless
 * `whenAnalysisModelExists` is 'add': then the elements without a structural
 * counterpart are derived into a new analysis model of their own, which does
 * not connect to the existing one.
 *
 * Idempotence. An element that already has a structural counterpart is
 * skipped ('already-idealised'), so a second run plans nothing. Apply refuses
 * a plan with nothing to write, a plan whose members' elements were deleted or
 * idealised or whose footings were deleted since it was made, and a model with
 * an analysis model (above). Apply does not compare geometry with the plan, so
 * a caller that holds a plan across edits plans again (the SDK and CLI plan
 * and apply in one call). Apply checks the whole plan before its first write
 * and writes inside one discardable transaction, so a refused plan writes
 * nothing. Nothing is replaced or removed.
 */

export type { Vec3 } from './host-geometry-frame.js';

/** Written on the analysis model, so a later run can tell a derived model from an authored one. */
export const DERIVED_ANALYSIS_MODEL_DESCRIPTION = 'Derived from the physical model by ifc-lite';
import type { Vec3 } from './host-geometry-frame.js';

/** An extruded prism in world metres: `outline` at its base, swept by `extrusion`. */
export interface PrismFact {
  /** Closed polygon, first point not repeated. */
  outline: Vec3[];
  /** Extrusion direction times depth. */
  extrusion: Vec3;
  /** False when `outline` is only the profile's bounding rectangle (I-shapes, circles, ...). */
  outlineExact: boolean;
}

export interface PhysicalElementFact {
  expressId: number;
  /** IFC PascalCase class, e.g. 'IfcBeamStandardCase'. */
  type: string;
  name: string | null;
  /** Containing storey; null when it has none. */
  storeyId: number | null;
  /** `Pset_*Common.LoadBearing`; null when absent. */
  loadBearing: boolean | null;
  /** The element already has a structural member or connection linked to it. */
  idealised: boolean;
  /** Straight Axis representation, world metres. */
  axis?: [Vec3, Vec3];
  prism?: PrismFact;
  /** Why no prism was read. */
  shapeIssue?: string;
  /** Body bounds in world metres; read for footings and piles only. */
  bounds?: { min: Vec3; max: Vec3 };
}

/** An IfcStructuralAnalysisModel already in the file. */
export interface ExistingAnalysisModel {
  expressId: number;
  name: string | null;
  /** Written by an earlier derivation. */
  derived: boolean;
}

export interface StructuralDerivationFacts {
  elements: PhysicalElementFact[];
  /** Storey used for items whose elements have none: the lowest one. */
  defaultStoreyId: number | null;
  existingAnalysisModels: ExistingAnalysisModel[];
}

export type SupportType = 'pinned' | 'fixed';

export interface StructuralDerivationOptions {
  /** Metres. Member ends closer than this share a node. Default 0.05. */
  tolerance?: number;
  /** Elements without a LoadBearing value: 'include' (default) or 'skip'. */
  whenLoadBearingUnknown?: 'include' | 'skip';
  /** Boundary condition of every support. Default 'pinned'. */
  supportType?: SupportType;
  /**
   * Metres a free end may move along its axis to meet another member; null (default) reads it from that
   * member's section. Never below `tolerance`: an end that already touches a member joins it.
   */
  jointReach?: number | null;
  /** When the file already has an analysis model: 'refuse' (default) or 'add' the missing members to a new one. */
  whenAnalysisModelExists?: 'refuse' | 'add';
}

export const DEFAULT_DERIVATION_OPTIONS: Required<StructuralDerivationOptions> = {
  tolerance: 0.05,
  whenLoadBearingUnknown: 'include',
  supportType: 'pinned',
  jointReach: null,
  whenAnalysisModelExists: 'refuse',
};

export type MemberLoadBearing = true | 'assumed';

export interface PlannedCurveMember {
  elementId: number;
  storeyId: number | null;
  start: Vec3;
  end: Vec3;
  /** Where the line came from. */
  axisSource: 'axis' | 'extrusion' | 'profile';
  startNode: number;
  endNode: number;
  loadBearing: MemberLoadBearing;
}

export interface PlannedSurfaceMember {
  elementId: number;
  storeyId: number | null;
  boundary: Vec3[];
  thickness: number;
  loadBearing: MemberLoadBearing;
}

export interface PlannedSupport {
  type: SupportType;
  basis: 'footing' | 'lowest-level';
  /** The footing or pile that carries it, for basis 'footing'. */
  footingId?: number;
  /** True when no footing was found and the support was placed by elevation. */
  guessed: boolean;
}

export interface PlannedNode {
  /** Index into `plan.nodes`. */
  index: number;
  position: Vec3;
  storeyId: number | null;
  /** Physical elements whose member ends meet here (footing excluded). */
  elementIds: number[];
  support?: PlannedSupport;
}

export type DerivationSkipReason =
  | 'already-idealised'
  | 'not-load-bearing'
  | 'load-bearing-unknown'
  | 'no-idealisable-shape'
  | 'shorter-than-tolerance'
  | 'footing-without-member-end';

export interface SkippedElement {
  elementId: number;
  type: string;
  name: string | null;
  reason: DerivationSkipReason;
  detail: string;
}

/** A member end moved along its own axis to meet another member. */
export interface ExtendedEnd {
  elementId: number;
  end: 'start' | 'end';
  /** Metres moved along the member, positive outwards (extended), negative inwards (trimmed). */
  distance: number;
  /** The physical element of the member it now meets. */
  toElementId: number;
}

/** A node that touches something it is not connected to. */
export interface UnconnectedEnd {
  node: number;
  /** The curve or surface member's physical element it lands on. */
  landsOnElementId: number;
  landsOn: 'member-interior' | 'surface-member';
}

export interface StructuralDerivationReport {
  counts: {
    curveMembers: number;
    surfaceMembers: number;
    nodes: number;
    supports: number;
    guessedSupports: number;
    assumedLoadBearing: number;
    skipped: number;
    extendedEnds: number;
    freeEnds: number;
  };
  skipped: SkippedElement[];
  /** Node indices of every guessed support. */
  guessedSupports: number[];
  extendedEnds: ExtendedEnd[];
  /** Node indices of every member end that meets no other member or support. */
  freeEnds: number[];
  unconnectedEnds: UnconnectedEnd[];
}

export interface StructuralDerivationPlan {
  options: Required<StructuralDerivationOptions>;
  defaultStoreyId: number | null;
  /** Analysis models already in the file; apply refuses unless `whenAnalysisModelExists` is 'add'. */
  existingAnalysisModels: ExistingAnalysisModel[];
  curveMembers: PlannedCurveMember[];
  surfaceMembers: PlannedSurfaceMember[];
  nodes: PlannedNode[];
  report: StructuralDerivationReport;
}

export interface StructuralDerivationApplied {
  analysisModelId: number;
}
