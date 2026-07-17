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

use super::brep::FacetedBrepProcessor;
use super::csg_primitive::{BlockProcessor, CsgSolidProcessor};
use super::extrusion::ExtrudedAreaSolidProcessor;
use super::helpers::parse_axis2_placement_3d;
use super::swept::{RevolvedAreaSolidProcessor, SweptDiskSolidProcessor};
use super::tessellated::TriangulatedFaceSetProcessor;
use crate::router::GeometryProcessor;

mod cut_heuristics;
mod halfspace_cap;
mod polygonal_prism;
use cut_heuristics::{
    cutter_below_skip_ratio, plane_is_coincident_with_host_face, quality_skips_small_cuts,
};
use halfspace_cap::cap_half_space_clip;

/// Maximum recursion depth for nested boolean operations.
/// Prevents stack overflow from deeply nested IfcBooleanResult chains.
/// In WASM, the stack is limited (~1-8MB), and each recursion level uses
/// significant stack space for CSG operations.
const MAX_BOOLEAN_DEPTH: u32 = 10;

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

    /// Drain the boolean-failure log accumulated since this processor was
    /// created (or the last `take_failures` call).
    pub fn take_failures(&self) -> Vec<BoolFailure> {
        std::mem::take(&mut *self.failures.borrow_mut())
    }

    fn record_failure(&self, op: BoolOp, reason: BoolFailureReason) {
        self.failures.borrow_mut().push(BoolFailure::new(op, reason));
    }

    /// Move every failure from `clipper` into this processor's log. Used
    /// after a transient `ClippingProcessor` instance is about to drop.
    fn drain_clipper_failures(&self, clipper: &ClippingProcessor) {
        let mut log = self.failures.borrow_mut();
        log.extend(clipper.take_failures());
    }

    /// If a DIFFERENCE clip emptied a non-empty host **and** the cutter's
    /// plane is coincident with one of the host's bounding-box faces,
    /// revert to the host and record the loss. The coincidence test is
    /// what keeps this from rendering geometry the model explicitly
    /// removed: a half-space deliberately placed far from the host so it
    /// engulfs the body (e.g. a demolition-phase cutter) still produces
    /// the correct empty mesh because no host face touches that plane.
    /// Only the Revit IFC2x3 "top-trim at exactly the wall top" pattern
    /// — issue #821 TallBuilding.ifc walls #615, #1297, #2401 and similar
    /// Revit exports where the spec-correct cut would erase the wall —
    /// hits the fallback.
    fn guard_against_full_host_removal(
        &self,
        host: Mesh,
        result: Mesh,
        plane_point: Point3<f64>,
        plane_normal: Vector3<f64>,
    ) -> Mesh {
        if host.is_empty() || !result.is_empty() {
            return result;
        }
        if !plane_is_coincident_with_host_face(&host, plane_point, plane_normal) {
            // Spec-correct full removal — respect the author's intent.
            return result;
        }
        self.record_failure(BoolOp::Difference, BoolFailureReason::DifferenceEmptiedHost);
        host
    }

    /// Process a solid operand with depth tracking
    fn process_operand_with_depth(
        &self,
        operand: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        match operand.ifc_type {
            IfcType::IfcExtrudedAreaSolid => {
                let processor = ExtrudedAreaSolidProcessor::new(self.schema.clone());
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcFacetedBrep => {
                let processor = FacetedBrepProcessor::new();
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcTriangulatedFaceSet => {
                let processor = TriangulatedFaceSetProcessor::new();
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcSweptDiskSolid => {
                let processor = SweptDiskSolidProcessor::new(self.schema.clone());
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcRevolvedAreaSolid => {
                let processor = RevolvedAreaSolidProcessor::new(self.schema.clone());
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcBlock => {
                BlockProcessor::new().process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcCsgSolid => CsgSolidProcessor::with_skip_small_cuts(self.skip_small_cuts)
                .process(operand, decoder, &self.schema, quality),
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                // Recursive case with depth tracking
                self.process_with_depth(operand, decoder, &self.schema, depth + 1, quality)
            }
            _ => Ok(Mesh::new()),
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
        // - Location = plane point (in world coordinates)
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

        // For DIFFERENCE operation with HalfSpaceSolid:
        // - AgreementFlag=.T. means material is on positive side of plane normal
        // - AgreementFlag=.F. means material is on negative side of plane normal
        // Since we're SUBTRACTING the half-space, we keep the opposite side:
        // - If material is on positive side (agreement=true), remove positive side → keep negative side → clip_normal = plane_normal
        // - If material is on negative side (agreement=false), remove negative side → keep positive side → clip_normal = -plane_normal
        let clip_normal = if agreement {
            plane_normal // Material on positive side, remove it, keep negative side
        } else {
            -plane_normal // Material on negative side, remove it, keep positive side
        };

        let plane = Plane::new(plane_point, clip_normal);
        let processor = ClippingProcessor::new();
        let mut clipped = processor.clip_mesh(mesh, &plane)?;
        // The plane clip removes the half-space but leaves the cut cross-section
        // OPEN (the BSP kernel's polygon cap was deleted with the BSP port in
        // #1024). Re-close it: a watertight host clipped by a plane leaves an
        // open boundary lying on that plane, forming the section to cap.
        cap_half_space_clip(&mut clipped, plane_point, clip_normal);
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
            // Operator must be DIFFERENCE.
            let op = current
                .get(0)
                .and_then(|v| match v {
                    ifc_lite_core::AttributeValue::Enum(e) => Some(e.as_str().to_string()),
                    _ => None,
                })
                .unwrap_or_else(|| ".DIFFERENCE.".to_string());
            if op != ".DIFFERENCE." && op != "DIFFERENCE" {
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
    /// Relies on a *watertight* CSG union of the cutter prisms (built by
    /// [`Self::build_cutter_union`]). No longer manifold-gated — the chain walk
    /// and cutter build are kernel-agnostic and must compile into the pure-Rust
    /// wasm — but it still DEFERS (returns `Ok(None)`) when no available kernel
    /// can produce that watertight union, so a non-manifold mesh-merge is never
    /// fed into the subtract.
    fn try_union_polygonal_chain(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
        quality: TessellationQuality,
    ) -> Result<Option<Mesh>> {
        let (base_entity, cutters) = self.collect_polygonal_chain(entity.clone(), decoder)?;
        if cutters.len() < 2 {
            return Ok(None);
        }

        // Process the base solid (the innermost first-operand). The chain is
        // walked iteratively above, so a 12-cutter chain reaches here at the
        // SAME `depth` as a 2-cutter one — the recursion-depth limit can't drop
        // it.
        let base_mesh = self.process_operand_with_depth(&base_entity, decoder, depth, quality)?;
        if base_mesh.is_empty() {
            return Ok(Some(base_mesh));
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
                _ => return Ok(None),
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
        for prism in &prisms {
            let trial = match clipper.subtract_mesh(&base_mesh, prism) {
                Ok(m) if !m.is_empty() => m,
                // Empty or errored single cut — the sequential path's per-cutter
                // fallback handles it better than a batched union would.
                _ => {
                    let _ = clipper.take_failures();
                    return Ok(None);
                }
            };
            if ClippingProcessor::difference_result_looks_degenerate(&base_mesh, &trial) {
                let _ = clipper.take_failures();
                return Ok(None);
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

        // Every cutter is a clean partial cut: union them into ONE watertight
        // solid (a true CSG union, so abutting roof segments share no internal
        // seam) and subtract once. This eliminates both the zero-thickness seam
        // fins that sequential subtraction leaves behind AND the deep-chain
        // MAX_BOOLEAN_DEPTH drops. `build_cutter_union` returns `None` when no
        // available kernel can union the prisms into a watertight solid; we
        // defer (like every other guard here) rather than feed a broken,
        // non-manifold union into the subtract — which the CSG kernel can't
        // classify, silently returning the host UNCHANGED (issue #960 wall
        // #2152: the gable-end wall rendered at full 7000 mm extrusion height).
        let combined = match self.build_cutter_union(&clipper, &prisms) {
            Some(m) if !m.is_empty() => m,
            _ => {
                // Unlike the trial-subtract probes above (whose failures the
                // sequential path re-encounters and re-logs), the union
                // attempt is unique to this path — preserve its kernel
                // failures and record the deferral, since the sequential
                // fallback can leave seam fins the batched subtract avoids.
                self.drain_clipper_failures(&clipper);
                self.record_failure(BoolOp::Union, BoolFailureReason::CutterUnionUnavailable);
                return Ok(None);
            }
        };
        let result = clipper.subtract_mesh(&base_mesh, &combined);
        self.drain_clipper_failures(&clipper);
        let clipped = match result {
            Ok(m)
                if !m.is_empty()
                    && !ClippingProcessor::difference_result_looks_degenerate(&base_mesh, &m) =>
            {
                m
            }
            // Kernel error or a degenerate union result — fall back to the
            // sequential per-cutter path.
            _ => return Ok(None),
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
            return Ok(None);
        }
        Ok(Some(clipped))
    }

    /// Union the chained-clip cutter prisms into ONE watertight solid.
    ///
    /// The segmented-roof cutters are prisms that ABUT along shared, exactly-
    /// coplanar faces (adjacent roof facets meeting at a hip/ridge/valley).
    /// Unioning them into a single watertight cutter is what lets the chain be
    /// subtracted ONCE (no seam fins, no deep-chain depth drops — issue #960).
    ///
    /// Returns `None` when no available kernel can produce a watertight union;
    /// the caller then defers to the sequential per-cutter path. We never feed a
    /// non-manifold mesh-merge into the subtract: the CSG kernel cannot classify
    /// a non-watertight cutter and silently returns the host UNCHANGED, leaving
    /// the gable-end wall at full extrusion height.
    fn build_cutter_union(&self, clipper: &ClippingProcessor, prisms: &[Mesh]) -> Option<Mesh> {
        if prisms.is_empty() {
            return None;
        }
        if prisms.len() == 1 {
            return Some(prisms[0].clone());
        }

        // Primary path: the pure-Rust kernel's N-ary union — ONE conforming
        // arrangement of all cutter prisms over a shared interner, so coplanar
        // seams shared by 3+ roof segments (and exactly-duplicated cutter prisms)
        // dissolve without the tearing that left-deep pairwise accumulation
        // produces. This makes the segmented-roof clip (#960) watertight on EVERY
        // build. Exact + platform-deterministic.
        {
            let refs: Vec<&Mesh> = prisms.iter().collect();
            let u = ClippingProcessor::consolidate_coplanar(
                crate::kernel::mesh_bridge::union_many(&refs),
            );
            if !u.is_empty() {
                return Some(u);
            }
        }

        // Fallback: the kernel's sequential multi-mesh union. Returns
        // `None` on empty/error so the caller defers to the per-cutter path.
        match clipper.union_meshes(prisms) {
            Ok(m) if !m.is_empty() => Some(m),
            _ => None,
        }
    }

    /// Internal processing with depth tracking to prevent stack overflow
    fn process_with_depth(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        depth: u32,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        // Depth limit to prevent stack overflow from deeply nested boolean chains
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

        // Get operator
        let operator = entity
            .get(0)
            .and_then(|v| match v {
                ifc_lite_core::AttributeValue::Enum(e) => Some(e.as_str()),
                _ => None,
            })
            .unwrap_or(".DIFFERENCE.");

        // A left-deep chain of `IfcBooleanClippingResult(.DIFFERENCE., x,
        // IfcPolygonalBoundedHalfSpace)` clips — the canonical "gable wall
        // trimmed by a segmented roof" pattern — is resolved by unioning all
        // cutter prisms into one solid and subtracting it once, rather than
        // applying each cutter sequentially. Two reasons (issue #960,
        // House.ifc):
        //
        //  1. **No seam slivers.** Sequentially subtracting two prisms that
        //     abut along a shared edge (adjacent roof segments meeting at a
        //     hip/valley) leaves the host material exactly on the seam as a
        //     zero-thickness, full-height fin — rendered double-sided, it is a
        //     visible wall sliver poking through the roof. A real CSG *union*
        //     dissolves the shared face, so the single subtract leaves nothing
        //     behind. (This is NOT the old mesh-*merge* batching that produced
        //     non-manifold cutters — `union_meshes` runs a true CSG union,
        //     which handles overlapping/duplicate cutters correctly.)
        //  2. **No depth-limit drops.** The chain is walked iteratively, so a
        //     wall clipped by 12+ roof planes no longer blows MAX_BOOLEAN_DEPTH
        //     and vanishes (House.ifc walls #4148/#2797/#5904).
        //
        // `try_union_polygonal_chain` returns `None` (fall through to the
        // sequential path below) whenever batching isn't provably safe, so the
        // per-cutter bounded→unbounded fallback still rescues full-cross-section
        // clips (duplex.ifc "Party Wall"). Verified mm-identical to IfcOpenShell
        // on all five reported House.ifc walls.
        //
        // The *correctness* of the single subtract hinges on a WATERTIGHT union
        // of the cutter prisms, which `build_cutter_union` computes with the
        // exact kernel's N-ary `union_many`. When it can't produce a watertight
        // union, `try_union_polygonal_chain` returns `None` and we fall through
        // to the sequential path — so this is never worse than pre-#960 (the
        // seam-sliver / deep-chain drop only fully resolves once that union is
        // watertight; 841_house_stack_overflow.ifc).
        if operator == ".DIFFERENCE." || operator == "DIFFERENCE" {
            if let Some(result) = self.try_union_polygonal_chain(entity, decoder, depth, quality)? {
                return Ok(result);
            }
        }

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
        // kernel, so we follow web-ifc: SEQUENTIAL through the
        // standard recursive path below. The per-step cutter is always a
        // single closed manifold prism, so the non-manifold-cutter root
        // cause is structurally eliminated.
        //
        // Performance: N CSG ops instead of 1 for chains of length N, but
        // each op runs on a SMALL single-cutter mesh (one polygon prism =
        // ~10-20 tris) rather than the combined N-cutter mesh, so wall-
        // clock cost is comparable. CSG cost scales with operand polygon
        // count, not operation count.
        //
        // See docs/research/csg-clipping-fidelity.md for the full
        // side-by-side comparison with the reference implementations.

        // Get first operand (base geometry)
        let first_operand_attr = entity
            .get(1)
            .ok_or_else(|| Error::geometry("BooleanResult missing FirstOperand".to_string()))?;

        let first_operand = decoder
            .resolve_ref(first_operand_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve FirstOperand".to_string()))?;

        // Process first operand to get base mesh
        let mesh = self.process_operand_with_depth(&first_operand, decoder, depth, quality)?;

        if mesh.is_empty() {
            return Ok(mesh);
        }

        // Get second operand
        let second_operand_attr = entity
            .get(2)
            .ok_or_else(|| Error::geometry("BooleanResult missing SecondOperand".to_string()))?;

        let second_operand = decoder
            .resolve_ref(second_operand_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve SecondOperand".to_string()))?;

        // Handle DIFFERENCE operation
        // Note: Parser may strip dots from enum values, so check both forms
        if operator == ".DIFFERENCE." || operator == "DIFFERENCE" {
            // Check if second operand is a half-space solid (simple or polygonally bounded)
            if second_operand.ifc_type == IfcType::IfcHalfSpaceSolid {
                // Simple half-space: use plane clipping
                let (plane_point, plane_normal, agreement) =
                    self.parse_half_space_solid(&second_operand, decoder)?;
                let clipped =
                    self.clip_mesh_with_half_space(&mesh, plane_point, plane_normal, agreement)?;
                return Ok(self.guard_against_full_host_removal(
                    mesh,
                    clipped,
                    plane_point,
                    plane_normal,
                ));
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
                    let clipper = ClippingProcessor::new();
                    let subtract_result = clipper.subtract_mesh(&mesh, &bound_mesh);
                    self.drain_clipper_failures(&clipper);
                    if let Ok(clipped) = subtract_result {
                        // The bounded-prism subtract is fragile on coincident
                        // faces: when the clip polygon spans the full host
                        // cross-section, the prism's in-plane side walls land
                        // exactly on the host's side faces and the CSG kernel
                        // can collapse the host to a near-empty sliver
                        // (duplex.ifc "Party Wall" segments #4287/#4399 —
                        // 12-tri box → 2-tri quad on the deleted legacy BSP
                        // kernel). When the result looks degenerate
                        // we fall through to the robust unbounded plane clip
                        // below: a strict superset of the bounded cut that is
                        // exactly correct whenever the polygon already covers
                        // the host's projected cross-section.
                        if !ClippingProcessor::difference_result_looks_degenerate(&mesh, &clipped) {
                            return Ok(self.guard_against_full_host_removal(
                                mesh,
                                clipped,
                                plane_point,
                                plane_normal,
                            ));
                        }
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
                return Ok(self.guard_against_full_host_removal(
                    mesh,
                    clipped,
                    plane_point,
                    plane_normal,
                ));
            }

            // Solid-solid difference on the exact kernel (no operand-size
            // cap). The old unconditional `SolidSolidDifferenceSkipped`
            // short-circuit here meant every CSG primitive cut (issue #780
            // bath, any `IfcCsgSolid` with a solid cutter) silently rendered
            // as the uncut host even when the operands were trivially small.
            let second_mesh =
                self.process_operand_with_depth(&second_operand, decoder, depth, quality)?;
            if second_mesh.is_empty() {
                self.record_failure(BoolOp::Difference, BoolFailureReason::EmptyOperand);
                return Ok(mesh);
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
                return Ok(mesh);
            }
            let clipper = ClippingProcessor::new();
            let result = clipper.subtract_mesh(&mesh, &second_mesh);
            self.drain_clipper_failures(&clipper);
            return result;
        }

        // Handle UNION operation — a real CSG union (overlap removed) on the
        // pure-Rust exact kernel.
        if operator == ".UNION." || operator == "UNION" {
            let second_mesh = self.process_operand_with_depth(&second_operand, decoder, depth, quality)?;
            if second_mesh.is_empty() {
                self.record_failure(BoolOp::Union, BoolFailureReason::EmptyOperand);
                return Ok(mesh);
            }
            let clipper = ClippingProcessor::new();
            let result = clipper.union_mesh(&mesh, &second_mesh);
            self.drain_clipper_failures(&clipper);
            return result;
        }

        // Handle INTERSECTION operation — a real intersection volume on the
        // pure-Rust exact kernel.
        if operator == ".INTERSECTION." || operator == "INTERSECTION" {
            let second_mesh =
                self.process_operand_with_depth(&second_operand, decoder, depth, quality)?;
            if second_mesh.is_empty() {
                self.record_failure(BoolOp::Intersection, BoolFailureReason::EmptyOperand);
                return Ok(Mesh::new());
            }
            let clipper = ClippingProcessor::new();
            let result = clipper.intersection_mesh(&mesh, &second_mesh);
            self.drain_clipper_failures(&clipper);
            return result;
        }

        self.record_failure(
            BoolOp::Unknown,
            BoolFailureReason::UnknownBooleanOperator(operator.to_string()),
        );
        Ok(mesh)
    }
}

impl GeometryProcessor for BooleanClippingProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        self.process_with_depth(entity, decoder, schema, 0, quality)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcBooleanResult, IfcType::IfcBooleanClippingResult]
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
