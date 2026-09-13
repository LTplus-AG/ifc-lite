// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! BooleanClipping processor - CSG operations.
//!
//! Handles IfcBooleanResult and IfcBooleanClippingResult for boolean operations
//! (DIFFERENCE, UNION, INTERSECTION).

use crate::diagnostics::{BoolFailure, BoolFailureReason, BoolOp};
use crate::{
    ClippingProcessor, Error, Mesh, Point3, Result, TessellationQuality, Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::cell::RefCell;

use super::csg_primitive::CsgSolidProcessor;
use super::helpers::parse_axis2_placement_3d;

mod cut_heuristics;
mod failures;
mod operand;
mod halfspace_cap;
mod polygonal_prism;
mod single_cutter_gate;
use single_cutter_gate::SingleCutterSubtract;
mod polygonal_union;
mod polygonal_removal;
use cut_heuristics::{cutter_below_skip_ratio, quality_skips_small_cuts};
use halfspace_cap::cap_half_space_clip;
#[cfg(test)]
use halfspace_cap::force_cdt_fail_on_ring_for_test;

/// Maximum recursion depth for nested boolean operations.
/// Prevents stack overflow from deeply nested IfcBooleanResult chains.
/// In WASM, the stack is limited (~1-8MB), and each recursion level uses
/// significant stack space for CSG operations.
const MAX_BOOLEAN_DEPTH: u32 = 10;

/// Longest chain of nested boolean/CSG operand nodes on one path. Bounds the
/// stack where `MAX_BOOLEAN_DEPTH` cannot: see `process_with_depth`.
///
/// Both boolean AND CSG nodes go into the set, so `len()` is an honest count of
/// recursion frames on the current path and this number means what it says. An
/// earlier revision counted booleans only and leaned on `IfcCsgSolid ->
/// IfcCsgSolid` being rejected elsewhere to keep the ratio bounded; see
/// `CsgSolidProcessor::process_with_boolean_cycle_guard` for why that was the
/// wrong trade.
const MAX_OPERAND_PATH_NODES: usize = 64;

pub(crate) use operand::{OperandPath, MAX_OPERAND_VISITS};

/// BooleanResult processor
/// Handles IfcBooleanResult and IfcBooleanClippingResult - CSG operations
///
/// Supports all IFC boolean operations:
/// - DIFFERENCE: Subtracts second operand from first (wall clipped by roof, openings, etc.)
///   - Uses efficient plane clipping for IfcHalfSpaceSolid operands
///   - Uses full 3D CSG for solid-solid operations (e.g., roof/slab clipping)
/// - UNION: Combines two solids into one
/// - INTERSECTION: Returns the overlapping volume of two solids
///
/// Performance notes:
/// - HalfSpaceSolid clipping is very fast (simple plane-based triangle clipping)
/// - Solid-solid CSG only invoked when actually needed (no overhead for simple geometry)
/// - Graceful fallback to first operand if CSG fails on degenerate meshes
pub struct BooleanClippingProcessor {
    schema: IfcSchema,
    /// Boolean failures recorded by this processor (the silent solid-solid
    /// skip, the polygonal-bounded half-space fallthrough, unknown operators)
    /// and drained from any internal `ClippingProcessor` instances. Drainable
    /// via [`Self::take_failures`].
    failures: RefCell<Vec<BoolFailure>>,
    /// Per-build small-cut skip (#1286). When set, a solid-solid DIFFERENCE
    /// whose cutter is far smaller than its host is dropped (host rendered
    /// un-cut) even at a full tessellation tier. Scoped to this processor
    /// instance — injected by the [`crate::router::GeometryRouter`] that
    /// constructs it — so concurrent native builds never bleed the flag into
    /// each other (was a process-wide static). `false` ⇒ every cut runs,
    /// byte-identical to before the optimization.
    skip_small_cuts: bool,
}

impl BooleanClippingProcessor {
    pub fn new() -> Self {
        Self::with_skip_small_cuts(false)
    }

    /// Construct with the per-build small-cut skip set (see
    /// [`Self::skip_small_cuts`]). The router injects the build's value here;
    /// nested boolean operands reuse the same `self`, and the only cross-
    /// processor boolean construction site (`CsgSolidProcessor`) forwards its
    /// own field so a whole CSG tree shares one scoped value.
    pub fn with_skip_small_cuts(skip_small_cuts: bool) -> Self {
        Self {
            schema: IfcSchema::new(),
            failures: RefCell::new(Vec::new()),
            skip_small_cuts,
        }
    }

    /// Parse IfcHalfSpaceSolid to get clipping plane
    /// Returns (plane_point, plane_normal, agreement_flag)
    fn parse_half_space_solid(
        &self,
        half_space: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(Point3<f64>, Vector3<f64>, bool)> {
        // IfcHalfSpaceSolid attributes:
        // 0: BaseSurface (IfcSurface - usually IfcPlane)
        // 1: AgreementFlag (boolean - true means material is on positive side)

        let surface_attr = half_space
            .get(0)
            .ok_or_else(|| Error::geometry("HalfSpaceSolid missing BaseSurface".to_string()))?;

        let surface = decoder
            .resolve_ref(surface_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve BaseSurface".to_string()))?;

        // Get agreement flag - defaults to true
        let agreement = half_space
            .get(1)
            .map(|v| match v {
                // Parser strips dots, so enum value is "T" or "F", not ".T." or ".F."
                ifc_lite_core::AttributeValue::Enum(e) => e != "F" && e != ".F.",
                _ => true,
            })
            .unwrap_or(true);

        // Parse IfcPlane
        if surface.ifc_type != IfcType::IfcPlane {
            return Err(Error::geometry(format!(
                "Expected IfcPlane for HalfSpaceSolid, got {}",
                surface.ifc_type
            )));
        }

        // IfcPlane has one attribute: Position (IfcAxis2Placement3D)
        let position_attr = surface
            .get(0)
            .ok_or_else(|| Error::geometry("IfcPlane missing Position".to_string()))?;

        let position = decoder
            .resolve_ref(position_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Plane position".to_string()))?;

        // Parse IfcAxis2Placement3D to get transformation matrix
        // The Position defines the plane's coordinate system:
        // - Location = plane point (in the representation item's local,
        //   pre-placement, pre-scale coordinates — this function does not
        //   compose the element's ObjectPlacement, which is folded in later
        //   by apply_placement at the element level)
        // - Z-axis (Axis) = plane normal (in local coordinates, needs transformation)
        let position_transform = parse_axis2_placement_3d(&position, decoder)?;

        // Plane point is the Position's Location (translation part of transform)
        let location = Point3::new(
            position_transform[(0, 3)],
            position_transform[(1, 3)],
            position_transform[(2, 3)],
        );

        // Plane normal is the Position's Z-axis transformed to world coordinates
        // Extract Z-axis from transform matrix (third column)
        let normal = Vector3::new(
            position_transform[(0, 2)],
            position_transform[(1, 2)],
            position_transform[(2, 2)],
        )
        .normalize();

        Ok((location, normal, agreement))
    }

    /// Apply half-space clipping to mesh
    fn clip_mesh_with_half_space(
        &self,
        mesh: &Mesh,
        plane_point: Point3<f64>,
        plane_normal: Vector3<f64>,
        agreement: bool,
    ) -> Result<Mesh> {
        use crate::csg::{ClippingProcessor, Plane};

        // DIFFERENCE with a HalfSpaceSolid. `clip_mesh` KEEPS the +`clip_normal`
        // side (`csg/plane_eps.rs`). AgreementFlag .T. puts the half-space
        // material on the NEGATIVE side of the surface normal, .F. on the
        // positive side (as in `polygonal_prism.rs`, `halfspace_cap.rs`), and
        // the material is what gets removed.
        let clip_normal = if agreement {
            plane_normal
        } else {
            -plane_normal
        };

        let plane = Plane::new(plane_point, clip_normal);
        let processor = ClippingProcessor::new();
        let mut clipped = processor.clip_mesh(mesh, &plane)?;
        // The plane clip removes the half-space but leaves the cut cross-section
        // OPEN (the BSP kernel's polygon cap was deleted with the BSP port in
        // #1024). Re-close it: a watertight host clipped by a plane leaves an
        // open boundary lying on that plane, forming the section to cap.
        //
        // `cap_half_space_clip` reports (measured, not assumed) whether it
        // actually closed the cut. Nothing downstream of this call consumes
        // that yet — the mesh is returned either way, same as before this
        // function reported anything, since an uncapped-but-otherwise-valid
        // mesh is still the least-bad output (see the fn's own doc). A
        // per-solid "was this fully watertight" signal is exactly what a
        // future geometric zone split needs to report per-piece integrity —
        // that consumer doesn't exist yet, so the bool is bound, not routed.
        let _capped = cap_half_space_clip(&mut clipped, plane_point, clip_normal);
        Ok(clipped)
    }

    /// Walk the left-spine of a chained
    /// `IfcBooleanClippingResult(.DIFFERENCE., x, polygonalBoundedHalfSpace)`
    /// pattern (typical for gable walls clipped by a segmented roof) and
    /// collect every consecutive `IfcPolygonalBoundedHalfSpace` cutter, plus
    /// the base solid the chain bottoms out on.
    ///
    /// Returns `(base_entity, cutters)` with `cutters` ordered innermost-first.
    /// Consumed by [`Self::try_union_polygonal_chain`], which unions the cutter
    /// prisms (a true CSG union — overlap-safe, unlike the old mesh-*merge*
    /// batching) and subtracts once. See that method for why a single unioned
    /// subtract beats sequential subtraction here (issue #960: seam slivers +
    /// deep-chain depth-limit drops).
    fn collect_polygonal_chain(
        &self,
        entity: DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(DecodedEntity, Vec<DecodedEntity>)> {
        let mut chain: Vec<DecodedEntity> = Vec::new();
        let mut current = entity;
        // Guard against self-referential / cyclic FirstOperand chains in
        // malformed input (e.g. `#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#10,
        // #20)`), which would otherwise walk `current = first` forever and grow
        // `chain` without bound (hang + OOM in the wasm geometry worker, where
        // panic=abort takes down the whole instance). A visited-id set breaks on
        // the first repeat WITHOUT capping legitimate deep-but-finite chains —
        // this walk was made iterative in #960 precisely to bypass
        // MAX_BOOLEAN_DEPTH for those, so a low depth cap would regress them.
        let mut visited: std::collections::HashSet<u32> = std::collections::HashSet::new();
        loop {
            if !visited.insert(current.id) {
                break;
            }
            if !matches!(
                current.ifc_type,
                IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult
            ) {
                break;
            }
            // Operator must be DIFFERENCE (an unreadable one on a bare
            // IfcBooleanResult is not).
            if operand::boolean_operator(&current) != Ok(BoolOp::Difference) {
                break;
            }
            let Some(second_attr) = current.get(2) else { break };
            let Ok(Some(second)) = decoder.resolve_ref(second_attr) else { break };
            if second.ifc_type != IfcType::IfcPolygonalBoundedHalfSpace {
                break;
            }
            chain.push(second);
            let Some(first_attr) = current.get(1) else { break };
            let Ok(Some(first)) = decoder.resolve_ref(first_attr) else { break };
            current = first;
        }
        // Reverse so chain[0] is the innermost (first-applied) clip.
        chain.reverse();
        Ok((current, chain))
    }

    /// Resolve a left-deep chain of
    /// `IfcBooleanClippingResult(.DIFFERENCE., x, IfcPolygonalBoundedHalfSpace)`
    /// clips by unioning every cutter prism into one solid and subtracting it
    /// from the base in a single operation. See the call site in
    /// [`Self::process_with_depth`] for the full rationale (issue #960: seam
    /// slivers + deep-chain depth-limit drops).
    ///
    /// Returns `Ok(None)` — defer to the standard sequential path — when the
    /// chain has fewer than two PBHS cutters, when a cutter prism fails to
    /// build, or when batching can't be proven safe (a full-cross-section
    /// cutter that needs the per-cutter unbounded-plane fallback, or a CSG
    /// union that silently under-removes).
    ///
    /// Relies on [`Self::build_cutter_union`] for the cutter-prism union.
    /// **Measured contract (issue #3980):** `build_cutter_union` does NOT
    /// verify that its union is watertight or even manifold — see its doc
    /// comment for the measured numbers on the real #960 fixture. It only
    /// requires a nonempty result and defers (`Ok(None)`) when the primary is
    /// empty and the fallback is empty or errors. What actually
    /// keeps a non-closed union from producing a wrong subtraction is
    /// downstream, in this function: the per-cutter trial-subtract probes,
    /// the intersected-bounds check on the batched subtract, the `#3919`
    /// accept-gate on the actual cut, and the `#3925` removal-bound check on
    /// the repair candidate. Those checks were sufficient on all five walls
    /// in the audited #960 fixture, but that is fixture evidence, not a
    /// closure proof.
    fn try_union_polygonal_chain(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
        quality: TessellationQuality,
        visited: &mut OperandPath,
    ) -> Result<Option<(Mesh, bool)>> {
        let (base_entity, cutters) = self.collect_polygonal_chain(entity.clone(), decoder)?;
        if cutters.len() < 2 {
            return Ok(None);
        }

        // Provisional from here: every deferral below goes through
        // `defer_after`, which discards what this attempt recorded.
        let mark = self.failure_mark();
        // Process the base solid (the innermost first-operand). The chain is
        // walked iteratively above, so a 12-cutter chain reaches here at the
        // SAME `depth` as a 2-cutter one — the recursion-depth limit can't drop
        // it.
        let (base_mesh, loss_recorded) = self.process_operand_checked(
            BoolOp::Unknown, &base_entity, decoder, depth, quality, visited)?;
        if base_mesh.is_empty() {
            // Nothing to cut. Returned, not deferred (a deferral re-meshes the
            // base at every spine level), with the flag the one-record rule needs.
            return Ok(Some((base_mesh, loss_recorded)));
        }

        // Build each cutter prism (bounds-clamped to the base).
        let mut prisms: Vec<Mesh> = Vec::with_capacity(cutters.len());
        for cutter in &cutters {
            let (plane_point, plane_normal, agreement) =
                self.parse_half_space_solid(cutter, decoder)?;
            match self.build_polygonal_bounded_half_space_mesh(
                cutter,
                decoder,
                &base_mesh,
                plane_point,
                plane_normal,
                agreement,
            ) {
                Ok(prism) if !prism.is_empty() => prisms.push(prism),
                // A cutter we can't build a prism for would be silently dropped
                // here; defer to the sequential path, which records the loss as
                // `PolygonalBoundedHalfSpaceFallback`.
                _ => return self.defer_after(mark),
            }
        }

        let clipper = ClippingProcessor::new();

        // Per-cutter trial subtracts serve two roles:
        //   * reject the chain if any single cutter is degenerate (a full-
        //     cross-section coincident-face clip whose bounded subtract is
        //     fragile — duplex.ifc "Party Wall" #4287/#4399, which the
        //     sequential path rescues via its bounded→unbounded fallback), and
        //   * record the intersection of every single-cutter result's bounds.
        //     The true answer (base minus the union of ALL cutters) is a subset
        //     of each single-cutter result, so its bounds can't exceed that
        //     intersection. If the unioned subtract below pokes outside it, the
        //     CSG union silently under-removed (manifold does this for near-
        //     coincident/duplicate cutters) and must not be trusted.
        let mut tight_min = Point3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
        let mut tight_max = Point3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
        let mut removal_bound = polygonal_removal::RemovalBound::new(&base_mesh);
        for prism in &prisms {
            // `subtract_checked` folds in the #3919 accept-gate check: a
            // rejection hands back the base UN-CUT, which would wrongly widen
            // tight_min/tight_max, so it is treated like empty/errored/degenerate.
            let Some(trial) = Self::subtract_checked(&clipper, &base_mesh, prism) else {
                let _ = clipper.take_failures();
                return self.defer_after(mark);
            };
            if !clipper.take_failures().is_empty() {
                // A diagnostic-only tear is not a default accept gate. It
                // cannot certify a moved cutter's removal bound, either.
                removal_bound.invalidate();
            } else {
                removal_bound.observe(&trial);
            }
            let (tmn, tmx) = trial.bounds();
            tight_min = Point3::new(
                tight_min.x.max(tmn.x),
                tight_min.y.max(tmn.y),
                tight_min.z.max(tmn.z),
            );
            tight_max = Point3::new(
                tight_max.x.min(tmx.x),
                tight_max.y.min(tmx.y),
                tight_max.z.min(tmx.z),
            );
        }
        let _ = clipper.take_failures();

        // Every cutter is a clean partial cut: union them into ONE solid (a
        // true CSG union, so abutting roof segments share no internal seam)
        // and subtract once. This is what eliminates the zero-thickness seam
        // fins that sequential subtraction leaves behind and the deep-chain
        // MAX_BOOLEAN_DEPTH drops. `build_cutter_union` returns `None` when
        // the primary result is empty and the fallback is empty or errors —
        // it does not check the union for closure (issue #3980; see its doc
        // comment for the measured contract) — so we still defer whenever no
        // kernel produces even a nonempty result, which is the case that used
        // to feed a broken union into the subtract and have the CSG kernel
        // silently return the host UNCHANGED (issue #960 wall #2152: the gable-end
        // wall rendered at full 7000 mm extrusion height).
        let combined = match self.build_cutter_union(&clipper, &prisms) {
            Some(m) if !m.is_empty() => m,
            _ => {
                // Unlike the trial-subtract probes above (whose failures the
                // sequential path re-encounters and re-logs), the union
                // attempt is unique to this path — preserve its kernel
                // failures and record the deferral, since the sequential
                // fallback can leave seam fins the batched subtract avoids.
                self.rewind_to(mark);
                self.absorb_failures(clipper.take_failures());
                self.record_failure(BoolOp::Union, BoolFailureReason::CutterUnionUnavailable);
                return Ok(None);
            }
        };
        // `subtract_checked` folds in the #3919 accept-gate check: a rejected
        // gate hands back the base UN-CUT — the same shape as "nothing to
        // cut", which `difference_result_looks_degenerate` can't catch — so
        // it is treated like a kernel error and defers to the sequential
        // per-cutter path (whose own accept-gate + #635 fallback handle it).
        // Uncaught, the full-height base used to be accepted here and the
        // issue-#960 seam sliver silently regrew.
        let mut checked = Self::subtract_checked(&clipper, &base_mesh, &combined);
        let mut cut_failures = clipper.take_failures();
        if (checked.is_none() || !cut_failures.is_empty()) && removal_bound.is_valid() {
            // #3925: a rejected or diagnostically torn cut permits one moved
            // candidate. Publish it only if its actual subtraction is clean;
            // otherwise retain the original result and its failure records.
            let refs: Vec<&Mesh> = prisms.iter().collect();
            let repaired = ClippingProcessor::consolidate_coplanar(
                crate::kernel::mesh_bridge::union_many(&refs));
            if !repaired.is_empty() {
                let candidate = Self::subtract_checked(&clipper, &base_mesh, &repaired);
                let candidate_failures = clipper.take_failures();
                if candidate.as_ref().is_some_and(|m| removal_bound.allows(m))
                    && candidate_failures.is_empty() {
                    checked = candidate;
                    cut_failures = candidate_failures;
                }
            }
        }
        self.absorb_failures(cut_failures);
        let Some(clipped) = checked else {
            return self.defer_after(mark);
        };

        // Reject a silently under-removing union: the result must fit inside the
        // intersection of the single-cutter result bounds (tolerance scaled to
        // the host size). If it pokes outside, the union dropped a cut — defer
        // to sequential. (duplex.ifc: a near-coincident cutter pair unions to
        // less than either alone.)
        let (rmn, rmx) = clipped.bounds();
        let diag = (tight_max.x - tight_min.x)
            .hypot(tight_max.y - tight_min.y)
            .hypot(tight_max.z - tight_min.z);
        let tol = (diag * 1e-3).max(1e-4);
        let under_removed = rmx.x > tight_max.x + tol
            || rmx.y > tight_max.y + tol
            || rmx.z > tight_max.z + tol
            || rmn.x < tight_min.x - tol
            || rmn.y < tight_min.y - tol
            || rmn.z < tight_min.z - tol;
        if under_removed {
            return self.defer_after(mark);
        }
        Ok(Some((clipped, false)))
    }

    /// Internal processing with depth tracking to prevent stack overflow.
    ///
    /// The LEFT spine — FirstOperand chains — is walked iteratively, so chain
    /// *length* never counts against `MAX_BOOLEAN_DEPTH`; the cap only guards
    /// genuine operand nesting (a boolean reached through a SecondOperand).
    /// Revit exports building-element-part chains up to 42 DIFFERENCE nodes
    /// deep; the recursive walk hit the cap at 10, errored, and the router
    /// dropped the whole element's geometry.
    ///
    /// The `bool` is true only when the mesh is empty and its loss is already
    /// on record, so a parent that meshed this node as an operand does not
    /// record it again (#4691; see `process_operand_checked`).
    pub(crate) fn process_with_depth(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        depth: u32,
        quality: TessellationQuality,
        visited: &mut OperandPath,
    ) -> Result<(Mesh, bool)> {
        // PATH-scoped, not global: a boolean tree is a DAG and one operand
        // legitimately referenced down two different branches must be PRESENT
        // in both (the accumulation is the parent's subtract, not the node's;
        // a memo could serve the second branch, see MAX_OPERAND_VISITS). Removing the id on
        // the way out breaks cycles without dropping real geometry — the same
        // choice `router/processing.rs` makes, and the opposite of the colour
        // resolvers, where the result is a pure function of the id so a global
        // set is both safe and stronger (#2864).
        // The set is path-scoped, so its LENGTH is the current operand-nesting
        // depth -- a chain bound for free, and one that covers the CSG hop.
        // It is needed because that hop passes `depth` UNCHANGED (a CsgSolid
        // is not itself a boolean nesting level), so a long ACYCLIC
        // `Boolean -> Csg -> Boolean` chain never advances MAX_BOOLEAN_DEPTH,
        // every `visited.insert` succeeds, and the recursion aborts on stack
        // depth alone. Measured: 4,000 links, SIGABRT (Codex, #2871/#2872
        // review; the same gap in this file).
        //
        // 64 sits well clear of MAX_BOOLEAN_DEPTH (10) so it cannot make that
        // cap's job harder, and clear of the 42-node Revit chains from #960,
        // which are FirstOperand SPINE nodes walked iteratively and never
        // reach here.
        if visited.len() >= MAX_OPERAND_PATH_NODES {
            return Err(Error::geometry(format!(
                "Boolean/CSG operand chain exceeds {MAX_OPERAND_PATH_NODES} nested nodes at #{}",
                entity.id
            )));
        }
        // Work budget, the one bound the two above cannot provide: a shared
        // SecondOperand is re-meshed on every path that reaches it (the set
        // is path-scoped on purpose), so `m` spine nodes per level all
        // pointing at one next-level boolean cost `m^levels` entries here
        // with no cycle and no long path. Recorded AND refused: the record
        // is what a consumer sees, the `Err` is what stops the work.
        if !visited.charge() {
            self.record_failure(
                BoolOp::Unknown,
                BoolFailureReason::OperandBudgetExhausted,
            );
            return Err(Error::geometry(format!(
                "Boolean/CSG operand walk exceeds {MAX_OPERAND_VISITS} node visits at #{}",
                entity.id
            )));
        }
        if !visited.insert(entity.id) {
            return Err(Error::geometry(format!(
                "Cyclic boolean/CSG operand reference at #{}",
                entity.id
            )));
        }
        let out = self.process_with_depth_inner(entity, decoder, schema, depth, quality, visited);
        visited.remove(entity.id);
        out
    }

    fn process_with_depth_inner(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        depth: u32,
        quality: TessellationQuality,
        visited: &mut OperandPath,
    ) -> Result<(Mesh, bool)> {
        // Depth limit to prevent stack overflow from nested boolean operands
        if depth > MAX_BOOLEAN_DEPTH {
            return Err(Error::geometry(format!(
                "Boolean nesting depth {} exceeds limit {}",
                depth, MAX_BOOLEAN_DEPTH
            )));
        }

        // IfcBooleanResult attributes:
        // 0: Operator (.DIFFERENCE., .UNION., .INTERSECTION.)
        // 1: FirstOperand (base geometry)
        // 2: SecondOperand (clipping geometry)

        // Walk down the left spine, collecting nodes whose second operands
        // are applied innermost-first once the base mesh exists.
        let mut spine: Vec<DecodedEntity> = Vec::new();
        let mut spine_seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
        let mut current = entity.clone();
        // Whether `mesh` (below) already carries a successfully BATCHED set of
        // PBHS cutters (`try_union_polygonal_chain`), as opposed to being the
        // untouched base solid. A leftover `spine` of length 1 is only the
        // true #3923 single-cutter shape (no sibling cutter anywhere) when
        // this is false; if a nested batch succeeded first, that node's own
        // cutter has siblings already folded into `mesh`, even though it is
        // the only node left in `spine` — see the `solo_step` comment below.
        let mut based_on_batch = false;
        // `empty_recorded`: the current empty mesh's loss is already on record
        // (one dropped operand, one record: see `process_operand_checked`).
        let (mut mesh, mut empty_recorded) = loop {
            if !spine_seen.insert(current.id) {
                // Cyclic FirstOperand chain (malformed input). The recursive
                // walk bottomed out on the depth cap; fail the same way with
                // a reason that names the actual problem.
                return Err(Error::geometry(format!(
                    "cyclic boolean FirstOperand chain at #{}",
                    current.id
                )));
            }
            if !matches!(
                current.ifc_type,
                IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult
            ) {
                // Bottom of the spine: the base solid.
                break self.process_operand_checked(
                    BoolOp::Unknown, &current, decoder, depth, quality, visited)?;
            }
            if operand::boolean_operator(&current) == Ok(BoolOp::Difference) {
                // The batched attempt meshes the base provisionally and can
                // be retried at every spine level it defers on. Those are real
                // node entries and remain charged: refunding them permits
                // nested deferrals to perform exponential work behind a
                // linear retained counter.
                let attempt =
                    self.try_union_polygonal_chain(&current, decoder, depth, quality, visited)?;
                if let Some(result) = attempt {
                    // Batched PBHS resolution handled this node and everything
                    // below it (see the comment on the sequential step).
                    based_on_batch = true;
                    break result;
                }
            }
            let first_attr = current.get(1).ok_or_else(|| {
                Error::geometry("BooleanResult missing FirstOperand".to_string())
            })?;
            let first = decoder
                .resolve_ref(first_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve FirstOperand".to_string()))?;
            spine.push(current);
            current = first;
        };

        // Apply each spine node's operator + SecondOperand, innermost-first.
        // `spine.len() == 1 && !based_on_batch` is the true #3923
        // single-cutter shape (no other node shares the job, and the mesh it
        // is cutting is the untouched base). `> 1` means a longer chain's
        // batching failed at every level, so each node here is a
        // one-cutter-at-a-time fallback. `spine.len() == 1 && based_on_batch`
        // is the same "one cutter at a time" shape: a nested batch already
        // succeeded on the levels below, so this lone leftover node's cutter
        // has siblings (the batched ones) even though `spine` holds only it —
        // see `single_cutter_gate.rs` for why that distinction matters to the
        // gate-rejection fallback.
        let solo_step = spine.len() == 1 && !based_on_batch;
        for node in spine.iter().rev() {
            if mesh.is_empty() {
                match operand::boolean_operator(node) {
                    // DIFFERENCE or INTERSECTION of nothing is nothing: skip
                    // the step (a UNION higher up still gets its second operand).
                    Ok(BoolOp::Difference | BoolOp::Intersection) => continue,
                    // UNION(empty, B) = B: the step runs on the second operand
                    // alone, and the emptied first operand is on record once.
                    Ok(BoolOp::Union) => {
                        self.record_empty_operand(BoolOp::Union, empty_recorded);
                        empty_recorded = true;
                    }
                    // Unknown or unreadable: the step records it, mesh unchanged.
                    Ok(BoolOp::Unknown) | Err(_) => {}
                }
            }
            let (stepped, dropped) =
                self.apply_boolean_step(node, mesh, decoder, depth, quality, visited, solo_step)?;
            // The flag follows the emptiness: a step that emptied the mesh by
            // dropping its operand recorded that; a later emptying is new.
            empty_recorded = stepped.is_empty() && (empty_recorded || dropped);
            mesh = stepped;
        }
        Ok((mesh, empty_recorded))
    }

    /// Apply one boolean node's operator and SecondOperand to an already-built
    /// first-operand mesh. Split out of [`Self::process_with_depth`] so the
    /// left spine can be applied iteratively.
    ///
    /// The spine walk in the caller resolves a left-deep chain of
    /// `IfcBooleanClippingResult(.DIFFERENCE., x, IfcPolygonalBoundedHalfSpace)`
    /// clips — the canonical "gable wall trimmed by a segmented roof" pattern
    /// — by unioning all cutter prisms into one solid and subtracting it once
    /// (`try_union_polygonal_chain`), rather than applying each cutter
    /// sequentially. Two reasons (issue #960, House.ifc):
    ///
    ///  1. **No seam slivers.** Sequentially subtracting two prisms that
    ///     abut along a shared edge (adjacent roof segments meeting at a
    ///     hip/valley) leaves the host material exactly on the seam as a
    ///     zero-thickness, full-height fin — rendered double-sided, it is a
    ///     visible wall sliver poking through the roof. A real CSG *union*
    ///     dissolves the shared face, so the single subtract leaves nothing
    ///     behind. (This is NOT the old mesh-*merge* batching that produced
    ///     non-manifold cutters — `union_meshes` runs a true CSG union,
    ///     which handles overlapping/duplicate cutters correctly.)
    ///  2. **No seam-order sensitivity for deep chains** — the batched cut
    ///     resolves 12+ abutting roof planes in one subtract (House.ifc
    ///     walls #4148/#2797/#5904).
    ///
    /// `try_union_polygonal_chain` returns `None` (fall through to this
    /// sequential step) whenever batching isn't provably safe, so the
    /// per-cutter bounded→unbounded fallback still rescues full-cross-section
    /// clips (duplex.ifc "Party Wall"). Verified Z-bound agreement with
    /// IfcOpenShell within 25 mm on all five reported House.ifc walls.
    /// `build_cutter_union` (the exact
    /// kernel's N-ary `union_many`, falling back to `union_meshes`) only
    /// requires a NONEMPTY union — it does not verify closure (issue #3980;
    /// see its doc comment for the measured contract on the real #960
    /// fixture). What actually guards the single subtract is downstream, in
    /// `try_union_polygonal_chain`: the intersected-bounds check and the
    /// `#3919` accept-gate on the actual cut. When `build_cutter_union`
    /// returns `None` (primary empty and fallback empty or errored) or those
    /// downstream checks reject the result, the chain falls through to this
    /// sequential path.
    ///
    /// `solo_step`: true when this is the ONLY node the caller's spine walk
    /// deferred to (a genuine single-PBHS-cutter DIFFERENCE, #3923's target
    /// shape); false when it's one of several nodes from a longer authored
    /// chain that couldn't be batched at any level and is now being applied
    /// one cutter at a time. See the `IfcPolygonalBoundedHalfSpace` branch
    /// below for why that distinction gates the accept-gate-rejection
    /// fallback.
    ///
    /// The `bool` is true only when the step emptied the mesh by dropping its
    /// second operand, a loss it has already recorded.
    fn apply_boolean_step(
        &self,
        entity: &DecodedEntity,
        mesh: Mesh,
        decoder: &mut EntityDecoder,
        depth: u32,
        quality: TessellationQuality,
        visited: &mut OperandPath,
        solo_step: bool,
    ) -> Result<(Mesh, bool)> {
        // An unknown or unreadable operator is recorded BEFORE SecondOperand is
        // resolved: that operand is unused, and a `$` there must not turn the
        // record into an `Err` that drops the parent's host.
        let operator = match operand::boolean_operator(entity) {
            Ok(op @ (BoolOp::Difference | BoolOp::Union | BoolOp::Intersection)) => op,
            other => {
                let keyword = other.map_or_else(str::to_string, |op| op.to_string());
                self.record_failure(BoolOp::Unknown, BoolFailureReason::UnknownBooleanOperator(keyword));
                return Ok((mesh, false));
            }
        };

        // NOTE: a previous version had a "fast path for chained polygonal-
        // bounded half-space clips" here that mesh-merged every cutter in
        // the chain into one combined mesh and ran a single BSP CSG op.
        // That batching is incorrect when chained cutter polygons OVERLAP
        // or DUPLICATE — the mesh-merge of two closed solids occupying
        // the same volume is non-manifold by construction, and BSP CSG on
        // a non-manifold cutter produces sliver artefacts (issue #583
        // AC20-Institute-Var-2 Wand-010, which has 4 chained cutters
        // including an exact duplicate at x=[17,25]).
        //
        // The reference implementations both handle this differently:
        //   - web-ifc:      strictly sequential. One CSG per IfcBooleanResult
        //                   node, recursing first-operand bottom-up.
        //   - ifcopenshell: batches via OCCT's topological CSG (handles
        //                   overlap natively) up to 8 operands, then falls
        //                   back to sequential past that.
        //
        // We can't do OCCT-style topological CSG in our mesh-CSG
        // kernel, so we follow web-ifc: SEQUENTIAL, one step per spine
        // node. The per-step cutter is always a single closed manifold
        // prism, so the non-manifold-cutter root cause is structurally
        // eliminated.
        //
        // Performance: N CSG ops instead of 1 for chains of length N, but
        // each op runs on a SMALL single-cutter mesh (one polygon prism =
        // ~10-20 tris) rather than the combined N-cutter mesh, so wall-
        // clock cost is comparable. CSG cost scales with operand polygon
        // count, not operation count.
        //
        // This keeps each operation bounded to one small cutter and preserves
        // IFC operand order.

        // Get second operand
        let second_operand_attr = entity
            .get(2)
            .ok_or_else(|| Error::geometry("BooleanResult missing SecondOperand".to_string()))?;

        let second_operand = decoder
            .resolve_ref(second_operand_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve SecondOperand".to_string()))?;

        // Handle DIFFERENCE operation
        if operator == BoolOp::Difference {
            // Check if second operand is a half-space solid (simple or polygonally bounded)
            if second_operand.ifc_type == IfcType::IfcHalfSpaceSolid {
                // Simple half-space: use plane clipping
                let (plane_point, plane_normal, agreement) =
                    self.parse_half_space_solid(&second_operand, decoder)?;
                let clipped =
                    self.clip_mesh_with_half_space(&mesh, plane_point, plane_normal, agreement)?;
                return Ok((self.guard_against_full_host_removal(
                    mesh,
                    clipped,
                    plane_point,
                    plane_normal,
                ), false));
            }

            if second_operand.ifc_type == IfcType::IfcPolygonalBoundedHalfSpace {
                let (plane_point, plane_normal, agreement) =
                    self.parse_half_space_solid(&second_operand, decoder)?;
                if let Ok(bound_mesh) = self.build_polygonal_bounded_half_space_mesh(
                    &second_operand,
                    decoder,
                    &mesh,
                    plane_point,
                    plane_normal,
                    agreement,
                ) {
                    // See `single_cutter_gate.rs` for the #3919/#3923
                    // accept-gate check and why a rejection's fallback
                    // depends on `solo_step`.
                    match self.resolve_single_cutter_subtract(&mesh, &bound_mesh, solo_step) {
                        SingleCutterSubtract::Clipped(clipped) => {
                            return Ok((self.guard_against_full_host_removal(
                                mesh,
                                clipped,
                                plane_point,
                                plane_normal,
                            ), false));
                        }
                        SingleCutterSubtract::KeepUncut => return Ok((mesh, false)),
                        SingleCutterSubtract::FallThrough => {}
                    }
                }

                // Bounded prism subtract failed (or its build did). The
                // unbounded plane clip *is* applied, but it's a strict
                // superset of the bounded cut — the polygonal boundary is
                // silently dropped. Flag so callers can surface the loss.
                self.record_failure(
                    BoolOp::Difference,
                    BoolFailureReason::PolygonalBoundedHalfSpaceFallback,
                );
                let clipped =
                    self.clip_mesh_with_half_space(&mesh, plane_point, plane_normal, agreement)?;
                return Ok((self.guard_against_full_host_removal(
                    mesh,
                    clipped,
                    plane_point,
                    plane_normal,
                ), false));
            }

            // Solid-solid difference on the exact kernel (no operand-size
            // cap). The old unconditional `SolidSolidDifferenceSkipped`
            // short-circuit here meant every CSG primitive cut (issue #780
            // bath, any `IfcCsgSolid` with a solid cutter) silently rendered
            // as the uncut host even when the operands were trivially small.
            let (second_mesh, loss_recorded) = self
                .process_operand_checked(BoolOp::Difference, &second_operand, decoder, depth, quality, visited)?;
            if second_mesh.is_empty() {
                self.record_empty_operand(BoolOp::Difference, loss_recorded);
                return Ok((mesh, false));
            }
            // Small-cut skip: a cutter far smaller than its host (a steel
            // cope/notch, a small detail recess) costs a full exact subtract —
            // the dominant load-time cost on boolean-heavy steel — for a
            // barely-visible change. Dropping it renders the host un-cut and
            // recovers Manifold-class load times. Enabled either by a preview
            // tessellation tier (Lowest/Low) OR by the per-build `skip_small_cuts`
            // field, which the viewer turns on WITHOUT dropping to a preview tier
            // so curves stay full-density while the tiny cuts are skipped (#1286).
            // The field is scoped to this processor (injected by the router), so
            // concurrent native builds never bleed it into one another. With
            // neither set (the default), EVERY cut runs — byte-identical to
            // before this optimization, on any tier.
            if (quality_skips_small_cuts(quality) || self.skip_small_cuts)
                && cutter_below_skip_ratio(&mesh, &second_mesh)
            {
                return Ok((mesh, false));
            }
            let clipper = ClippingProcessor::new();
            let outcome = clipper.subtract_mesh(&mesh, &second_mesh);
            self.absorb_failures(clipper.take_failures());
            // A rejection keeps the host un-cut; any failure is on record above.
            return Ok((outcome.into_mesh().unwrap_or(mesh), false));
        }

        // Handle UNION operation — a real CSG union (overlap removed) on the
        // pure-Rust exact kernel.
        if operator == BoolOp::Union {
            let (second_mesh, loss_recorded) = self
                .process_operand_checked(BoolOp::Union, &second_operand, decoder, depth, quality, visited)?;
            if second_mesh.is_empty() {
                self.record_empty_operand(BoolOp::Union, loss_recorded);
                return Ok((mesh, false));
            }
            let clipper = ClippingProcessor::new();
            let result = clipper.union_mesh(&mesh, &second_mesh);
            self.absorb_failures(clipper.take_failures());
            return result.map(|m| (m, false));
        }

        // What is left is INTERSECTION: a real intersection volume on the
        // pure-Rust exact kernel.
        let (second_mesh, loss_recorded) = self
            .process_operand_checked(BoolOp::Intersection, &second_operand, decoder, depth, quality, visited)?;
        if second_mesh.is_empty() {
            self.record_empty_operand(BoolOp::Intersection, loss_recorded);
            // Emptied by a dropped operand that is now on record.
            return Ok((Mesh::new(), true));
        }
        let clipper = ClippingProcessor::new();
        let result = clipper.intersection_mesh(&mesh, &second_mesh);
        self.absorb_failures(clipper.take_failures());
        result.map(|m| (m, false))
    }
}

impl Default for BooleanClippingProcessor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod halfspace_cap_tests;

#[cfg(test)]
mod chain_cycle_tests;
