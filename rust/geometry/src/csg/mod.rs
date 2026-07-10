// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! CSG (Constructive Solid Geometry) Operations
//!
//! Fast triangle clipping and boolean operations.

use crate::diagnostics::{BoolFailure, BoolFailureReason, BoolOp};
use crate::error::Result;
use crate::mesh::Mesh;
use nalgebra::{Point3, Vector3};
use smallvec::SmallVec;
use std::cell::RefCell;

mod consolidate;
mod normals;

pub use normals::calculate_normals;
pub(crate) use consolidate::tri_is_needle;

/// Type alias for small triangle collections (typically 1-2 triangles from clipping)
pub type TriangleVec = SmallVec<[Triangle; 4]>;

/// Plane definition for clipping
#[derive(Debug, Clone, Copy)]
pub struct Plane {
    /// Point on the plane
    pub point: Point3<f64>,
    /// Normal vector (must be normalized)
    pub normal: Vector3<f64>,
}

impl Plane {
    /// Create a new plane
    pub fn new(point: Point3<f64>, normal: Vector3<f64>) -> Self {
        Self {
            point,
            normal: normal.normalize(),
        }
    }

    /// Calculate signed distance from point to plane
    /// Positive = in front, Negative = behind
    pub fn signed_distance(&self, point: &Point3<f64>) -> f64 {
        (point - self.point).dot(&self.normal)
    }
}

/// Triangle clipping result
#[derive(Debug, Clone)]
pub enum ClipResult {
    /// Triangle is completely in front (keep it)
    AllFront(Triangle),
    /// Triangle is completely behind (discard it)
    AllBehind,
    /// Triangle intersects plane - returns new triangles (uses SmallVec to avoid heap allocation)
    Split(TriangleVec),
}

/// Triangle definition
#[derive(Debug, Clone)]
pub struct Triangle {
    pub v0: Point3<f64>,
    pub v1: Point3<f64>,
    pub v2: Point3<f64>,
}

impl Triangle {
    /// Create a new triangle
    #[inline]
    pub fn new(v0: Point3<f64>, v1: Point3<f64>, v2: Point3<f64>) -> Self {
        Self { v0, v1, v2 }
    }

    /// Calculate triangle normal
    #[inline]
    pub fn normal(&self) -> Vector3<f64> {
        let edge1 = self.v1 - self.v0;
        let edge2 = self.v2 - self.v0;
        edge1.cross(&edge2).normalize()
    }

    /// Calculate the cross product of edges, which is twice the area vector.
    ///
    /// Returns a `Vector3<f64>` perpendicular to the triangle plane.
    /// For degenerate/collinear triangles, returns the zero vector.
    /// Use `is_degenerate()` or `try_normalize()` on the result if you need
    /// to detect and handle degenerate cases.
    #[inline]
    pub fn cross_product(&self) -> Vector3<f64> {
        let edge1 = self.v1 - self.v0;
        let edge2 = self.v2 - self.v0;
        edge1.cross(&edge2)
    }

    /// Calculate triangle area (half the magnitude of the cross product).
    #[inline]
    pub fn area(&self) -> f64 {
        self.cross_product().norm() * 0.5
    }

    /// Check if triangle is degenerate (zero area, collinear vertices).
    ///
    /// Uses `try_normalize` on the cross product with the specified epsilon.
    /// Returns `true` if the cross product cannot be normalized (i.e., degenerate).
    #[inline]
    pub fn is_degenerate(&self, epsilon: f64) -> bool {
        self.cross_product().try_normalize(epsilon).is_none()
    }
}

/// One recorded invocation of a CSG kernel op (perf-census diagnostics).
/// `op`: 0=subtract 1=union 2=intersection
/// 3=clip. `a_tris`/`b_tris` are the operand triangle counts — the arrangement
/// cost driver — so the census measures the *real* heavy-path workload reaching
/// the kernel (analytic AABB box clips never get here).
#[derive(Clone, Copy, Debug)]
pub struct CsgOpRecord {
    pub op: u8,
    pub a_tris: u32,
    pub b_tris: u32,
}

// Global (Mutex) so it captures ops on rayon worker threads, not just the caller.
static CSG_CENSUS: std::sync::Mutex<Vec<CsgOpRecord>> = std::sync::Mutex::new(Vec::new());

/// Clear the CSG op census (call before a measured run).
pub fn reset_csg_census() {
    if let Ok(mut g) = CSG_CENSUS.lock() {
        g.clear();
    }
}

/// Drain the CSG op census (call after a measured run).
pub fn take_csg_census() -> Vec<CsgOpRecord> {
    CSG_CENSUS
        .lock()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default()
}

#[inline]
fn record_csg_op(op: u8, a_tris: usize, b_tris: usize) {
    if let Ok(mut g) = CSG_CENSUS.lock() {
        g.push(CsgOpRecord {
            op,
            a_tris: a_tris as u32,
            b_tris: b_tris as u32,
        });
    }
}

/// CSG Clipping Processor
pub struct ClippingProcessor {
    /// Epsilon for floating point comparisons
    pub epsilon: f64,
    /// Boolean / CSG failures recorded since the last `take_failures()`.
    /// Interior-mutable so the existing `&self` API stays unchanged.
    failures: RefCell<Vec<BoolFailure>>,
}

impl ClippingProcessor {
    /// Create a new clipping processor
    pub fn new() -> Self {
        Self {
            epsilon: 1e-6,
            failures: RefCell::new(Vec::new()),
        }
    }

    /// Drain and return the failures recorded by this processor since its
    /// creation (or the last `take_failures` call). The processor's internal
    /// log is cleared.
    pub fn take_failures(&self) -> Vec<BoolFailure> {
        std::mem::take(&mut *self.failures.borrow_mut())
    }

    /// Number of failures currently buffered (without draining).
    pub fn failure_count(&self) -> usize {
        self.failures.borrow().len()
    }

    /// Whether any failure recorded since index `since` (a prior
    /// [`failure_count`](Self::failure_count)) was an `OperandTooLarge`
    /// rejection. HISTORICAL: only the deleted BSP polygon cap ever
    /// emitted this from the boolean ops — the exact kernel has no operand
    /// cap, so this is now always `false` on the boolean path. Kept because
    /// the void router still keys its AABB-fallback decision on it
    /// (issue #635 / #947), which is conservative and correct either way.
    pub(crate) fn has_operand_too_large_since(&self, since: usize) -> bool {
        let failures = self.failures.borrow();
        let since = since.min(failures.len());
        failures[since..]
            .iter()
            .any(|f| matches!(f.reason, BoolFailureReason::OperandTooLarge { .. }))
    }

    /// Internal: append a failure record. Public-crate so the boolean
    /// processor in `processors/boolean.rs` can record fallbacks that
    /// happen above the kernel layer.
    pub(crate) fn record_failure(&self, op: BoolOp, reason: BoolFailureReason) {
        self.failures.borrow_mut().push(BoolFailure::new(op, reason));
    }

    /// Clip a triangle against a plane
    /// Returns triangles that are in front of the plane
    pub fn clip_triangle(&self, triangle: &Triangle, plane: &Plane) -> ClipResult {
        // Calculate signed distances for all vertices
        let d0 = plane.signed_distance(&triangle.v0);
        let d1 = plane.signed_distance(&triangle.v1);
        let d2 = plane.signed_distance(&triangle.v2);

        // Edge intersection parameter, clamped to the segment. Vertices are
        // classified front/back with an epsilon band (`d >= -epsilon`), so a
        // "front" vertex can sit slightly behind the plane (d in [-epsilon, 0)).
        // Feeding that raw distance into `d_front / (d_front - d_back)` yields a
        // t outside [0, 1] — and when the plane is nearly coincident with a host
        // face the denominator collapses, extrapolating the cut vertex far off
        // the edge (issue #1155: a clipped column flew ~97 m). Clamping keeps the
        // intersection on the edge; the near-zero guard avoids a NaN from a
        // degenerate (in-plane) edge.
        let edge_t = |d_front: f64, d_back: f64| -> f64 {
            let denom = d_front - d_back;
            if denom.abs() < 1.0e-12 {
                0.0
            } else {
                (d_front / denom).clamp(0.0, 1.0)
            }
        };

        // Count vertices in front of plane
        let mut front_count = 0;
        if d0 >= -self.epsilon {
            front_count += 1;
        }
        if d1 >= -self.epsilon {
            front_count += 1;
        }
        if d2 >= -self.epsilon {
            front_count += 1;
        }

        match front_count {
            // All vertices behind - discard triangle
            0 => ClipResult::AllBehind,

            // All vertices in front - keep triangle
            3 => ClipResult::AllFront(triangle.clone()),

            // One vertex in front - create 1 smaller triangle
            1 => {
                let (front, back1, back2) = if d0 >= -self.epsilon {
                    (triangle.v0, triangle.v1, triangle.v2)
                } else if d1 >= -self.epsilon {
                    (triangle.v1, triangle.v2, triangle.v0)
                } else {
                    (triangle.v2, triangle.v0, triangle.v1)
                };

                // Interpolate to find intersection points
                let d_front = if d0 >= -self.epsilon {
                    d0
                } else if d1 >= -self.epsilon {
                    d1
                } else {
                    d2
                };
                let d_back1 = if d0 >= -self.epsilon {
                    d1
                } else if d1 >= -self.epsilon {
                    d2
                } else {
                    d0
                };
                let d_back2 = if d0 >= -self.epsilon {
                    d2
                } else if d1 >= -self.epsilon {
                    d0
                } else {
                    d1
                };

                let t1 = edge_t(d_front, d_back1);
                let t2 = edge_t(d_front, d_back2);

                let p1 = front + (back1 - front) * t1;
                let p2 = front + (back2 - front) * t2;

                ClipResult::Split(smallvec::smallvec![Triangle::new(front, p1, p2)])
            }

            // Two vertices in front - create 2 triangles
            2 => {
                let (front1, front2, back) = if d0 < -self.epsilon {
                    (triangle.v1, triangle.v2, triangle.v0)
                } else if d1 < -self.epsilon {
                    (triangle.v2, triangle.v0, triangle.v1)
                } else {
                    (triangle.v0, triangle.v1, triangle.v2)
                };

                // Interpolate to find intersection points
                let d_back = if d0 < -self.epsilon {
                    d0
                } else if d1 < -self.epsilon {
                    d1
                } else {
                    d2
                };
                let d_front1 = if d0 < -self.epsilon {
                    d1
                } else if d1 < -self.epsilon {
                    d2
                } else {
                    d0
                };
                let d_front2 = if d0 < -self.epsilon {
                    d2
                } else if d1 < -self.epsilon {
                    d0
                } else {
                    d1
                };

                let t1 = edge_t(d_front1, d_back);
                let t2 = edge_t(d_front2, d_back);

                let p1 = front1 + (back - front1) * t1;
                let p2 = front2 + (back - front2) * t2;

                ClipResult::Split(smallvec::smallvec![
                    Triangle::new(front1, front2, p1),
                    Triangle::new(front2, p2, p1),
                ])
            }

            _ => unreachable!(),
        }
    }

    /// Check if two meshes' bounding boxes overlap
    fn bounds_overlap(host_mesh: &Mesh, opening_mesh: &Mesh) -> bool {
        let (host_min, host_max) = host_mesh.bounds();
        let (open_min, open_max) = opening_mesh.bounds();

        // Issue #977: this runs on the *un-inflated* cutter, before
        // `manifold_kernel::difference` inflates it. A recess whose cut face is
        // exactly flush with a host face touches the host's AABB right at the
        // boundary; strict `<`/`>` would classify it as non-overlapping and drop
        // the cut before inflation ever runs. Use inclusive `<=`/`>=` with a small
        // *relative* epsilon (scaled to the operands, so it is unit-robust across
        // mm/m models) to keep flush cutters in play without admitting genuinely
        // disjoint operands.
        let span = (host_max.x - host_min.x)
            .max(host_max.y - host_min.y)
            .max(host_max.z - host_min.z)
            .max(open_max.x - open_min.x)
            .max(open_max.y - open_min.y)
            .max(open_max.z - open_min.z);
        let eps = span * 1e-6;

        let overlap_x = open_min.x - eps <= host_max.x && open_max.x + eps >= host_min.x;
        let overlap_y = open_min.y - eps <= host_max.y && open_max.y + eps >= host_min.y;
        let overlap_z = open_min.z - eps <= host_max.z && open_max.z + eps >= host_min.z;

        overlap_x && overlap_y && overlap_z
    }

    /// Subtract opening mesh from host mesh using CSG boolean operations
    /// on the pure-Rust exact mesh-arrangement kernel.
    ///
    /// On any failure path the host is returned un-cut and a [`BoolFailure`]
    /// record is appended to the processor's failure log (drainable via
    /// [`Self::take_failures`]). An empty host returns an empty mesh without
    /// recording a failure (it's a fast path, not a fallback).
    pub fn subtract_mesh(&self, host_mesh: &Mesh, opening_mesh: &Mesh) -> Result<Mesh> {
        record_csg_op(0, host_mesh.triangle_count(), opening_mesh.triangle_count());
        if host_mesh.is_empty() {
            return Ok(Mesh::new());
        }
        if opening_mesh.is_empty() {
            self.record_failure(BoolOp::Difference, BoolFailureReason::EmptyOperand);
            return Ok(host_mesh.clone());
        }
        if !Self::bounds_overlap(host_mesh, opening_mesh) {
            self.record_failure(BoolOp::Difference, BoolFailureReason::NoBoundsOverlap);
            return Ok(host_mesh.clone());
        }

        // Pure-Rust exact mesh-arrangement kernel, with consolidate_coplanar
        // merging per-face fragments to match Manifold's clean output.
        //
        // NB: the kernel output itself is the watertightness bar — the
        // crack-family fix lives upstream (`promote_cutter_verts_onto_host_faces`'s
        // exact-plane lift). `consolidate_coplanar` can still re-open a closed
        // cut along a µm-offset plane pair (each bucket earcuts independently,
        // breaking the shared boundary chain); a closure-preserving guard here
        // was tried and REJECTED — on FZK-Haus gable walls the raw kernel
        // output carries >50:1 needle fragments that consolidation legitimately
        // merges (the pinned `csg_quality_regression` spike bar). A
        // seam-preserving consolidation is the remaining follow-up.
        crate::kernel::budget::begin();
        let raw = crate::kernel::mesh_bridge::subtract(host_mesh, opening_mesh);
        // Deterministic escalation guardrail (#1109): if the exact predicate
        // cascade escalated past the per-boolean budget, the cut bailed mid-
        // arrangement. Discard the partial result and return the host un-cut so
        // the void router's #635 AABB box-cut fallback fires. The trip point is a
        // pure function of the snapped operands, so server (native) and client
        // (wasm) degrade the SAME element identically — parity preserved.
        if crate::kernel::budget::tripped() {
            self.record_failure(
                BoolOp::Difference,
                BoolFailureReason::OperandTooLarge {
                    polys_a: host_mesh.triangle_count(),
                    polys_b: opening_mesh.triangle_count(),
                },
            );
            return Ok(host_mesh.clone());
        }
        let result = Self::consolidate_coplanar(raw);
        if !result.is_empty() && !self.validate_mesh(&result) {
            self.record_failure(BoolOp::Difference, BoolFailureReason::KernelOutputInvalid);
            return Ok(host_mesh.clone());
        }
        Ok(result)
    }

    /// Subtract a GROUP of pairwise-disjoint opening cutters from the host in
    /// ONE conforming arrangement (disjoint-cutter batching).
    ///
    /// A REJECTED group (the N-ary arrangement could not fully conform, or no
    /// cutter overlaps the host) returns the host UN-CUT and records NO
    /// failure: rejection is the expected, handled outcome — the router's
    /// per-opening sequential loop (with the full #635 fallback machinery and
    /// its own diagnostics) immediately takes over for the group's members, so
    /// a failure record here would be pure noise on elements whose voids end
    /// up perfectly cut (the issue-582/583 zero-CSG-failure bar). Only a
    /// genuinely invalid kernel OUTPUT records, exactly like
    /// [`Self::subtract_mesh`].
    pub fn subtract_mesh_many(&self, host_mesh: &Mesh, cutters: &[&Mesh]) -> Result<Mesh> {
        if host_mesh.is_empty() {
            return Ok(Mesh::new());
        }
        let live: Vec<&Mesh> = cutters
            .iter()
            .copied()
            .filter(|c| !c.is_empty() && Self::bounds_overlap(host_mesh, c))
            .collect();
        if live.is_empty() {
            return Ok(host_mesh.clone()); // silent: sequential path takes over
        }
        // Cap the cutters packed into ONE conforming arrangement. Void cutters
        // here are order-free (set difference: host − {all} ≡ host − {chunk₁} −
        // {chunk₂} − …), and the N-ary arrangement cost is SUPER-LINEAR in the
        // cutters in a single arrangement. A Revit IfcBuildingElementPart with
        // ~90 openings cost ~12 s in one arrangement vs ~0.4 s chunked at 16 (30×),
        // and on wasm that single element alone blew the geometry-stream watchdog —
        // an 86 MB model that loaded in ~15 s natively STALLED at 40 s in the
        // browser. Chunking bounds the per-arrangement cost so no single element
        // can stall the stream. It is solid-equivalent (the batch path's contract
        // is volume parity + watertightness, not byte-identical tessellation); for
        // live.len() <= MAX_CUTTERS_PER_ARRANGEMENT it IS the prior single
        // arrangement. On any chunk's budget trip / unrecovered constraint, reject
        // the WHOLE group (return host un-cut) so the per-opening sequential path
        // (own budget + #635 AABB fallback) takes over — identical to before.
        const MAX_CUTTERS_PER_ARRANGEMENT: usize = 16;
        let mut result = host_mesh.clone();
        for chunk in live.chunks(MAX_CUTTERS_PER_ARRANGEMENT) {
            // Census: record THIS kernel invocation's real operand sizes (the
            // current host + this chunk's cutters). Chunking runs the kernel once
            // per chunk, so report K real ops, not one synthetic op carrying the
            // whole group's cutter total. For live.len() <= cap this is one record
            // identical to the prior single arrangement.
            let chunk_tris: usize = chunk.iter().map(|c| c.triangle_count()).sum();
            record_csg_op(0, result.triangle_count(), chunk_tris);
            crate::kernel::budget::begin();
            let raw = crate::kernel::mesh_bridge::subtract_many(&result, chunk);
            if crate::kernel::budget::tripped() {
                // Escalation budget exceeded (#1109): reject the group silently so
                // the per-opening sequential path takes over (deterministic).
                return Ok(host_mesh.clone());
            }
            let Some(raw) = raw else {
                // Unrecovered constraint in this chunk's arrangement — reject the
                // group so the sequential per-opening path takes over.
                return Ok(host_mesh.clone());
            };
            let next = Self::consolidate_coplanar(raw);
            // Validate each intermediate BEFORE it becomes the next chunk's host:
            // a non-watertight / invalid intermediate would silently corrupt every
            // subsequent subtraction. On failure reject the whole group so the
            // per-opening sequential path takes over — same guard as the
            // un-chunked path, just applied per chunk.
            if !next.is_empty() && !self.validate_mesh(&next) {
                self.record_failure(BoolOp::Difference, BoolFailureReason::KernelOutputInvalid);
                return Ok(host_mesh.clone());
            }
            result = next;
        }
        Ok(result)
    }

    /// Union two meshes together using CSG boolean operations on the
    /// pure-Rust exact kernel.
    ///
    /// Empty operands are handled silently — they have a unique correct answer.
    pub fn union_mesh(&self, mesh_a: &Mesh, mesh_b: &Mesh) -> Result<Mesh> {
        record_csg_op(1, mesh_a.triangle_count(), mesh_b.triangle_count());
        if mesh_a.is_empty() {
            return Ok(mesh_b.clone());
        }
        if mesh_b.is_empty() {
            return Ok(mesh_a.clone());
        }

        // Pure-Rust exact kernel. On an empty/invalid kernel result
        // fall back to a plain merge (overlap not removed) + record the failure,
        // preserving the legacy never-Err contract.
        let raw_u = crate::kernel::mesh_bridge::union(mesh_a, mesh_b);
        let result = Self::consolidate_coplanar(raw_u);
        if result.is_empty() || !self.validate_mesh(&result) {
            self.record_failure(BoolOp::Union, BoolFailureReason::KernelOutputInvalid);
            let mut merged = mesh_a.clone();
            merged.merge(mesh_b);
            return Ok(merged);
        }
        Ok(result)
    }

    /// Intersect two meshes using CSG boolean operations on the pure-Rust
    /// exact kernel.
    ///
    /// Returns the intersection of two meshes (the volume where both
    /// overlap).
    pub fn intersection_mesh(&self, mesh_a: &Mesh, mesh_b: &Mesh) -> Result<Mesh> {
        record_csg_op(2, mesh_a.triangle_count(), mesh_b.triangle_count());
        if mesh_a.is_empty() || mesh_b.is_empty() {
            return Ok(Mesh::new());
        }

        // Pure-Rust exact kernel. An empty result is legitimate
        // (disjoint operands → empty intersection).
        let result =
            Self::consolidate_coplanar(crate::kernel::mesh_bridge::intersection(mesh_a, mesh_b));
        if !result.is_empty() && !self.validate_mesh(&result) {
            self.record_failure(BoolOp::Intersection, BoolFailureReason::KernelOutputInvalid);
            return Ok(Mesh::new());
        }
        Ok(result)
    }

    /// Union multiple meshes together
    ///
    /// Convenience method that sequentially unions all non-empty meshes.
    /// Skips empty meshes to avoid unnecessary CSG operations.
    pub fn union_meshes(&self, meshes: &[Mesh]) -> Result<Mesh> {
        if meshes.is_empty() {
            return Ok(Mesh::new());
        }

        if meshes.len() == 1 {
            return Ok(meshes[0].clone());
        }

        // Start with first non-empty mesh
        let mut result = Mesh::new();
        let mut found_first = false;

        for mesh in meshes {
            if mesh.is_empty() {
                continue;
            }

            if !found_first {
                result = mesh.clone();
                found_first = true;
                continue;
            }

            result = self.union_mesh(&result, mesh)?;
        }

        Ok(result)
    }

    /// Heuristic: does this look like a botched CSG difference?
    ///
    /// Kernel-neutral check used by the boolean processor (e.g. the
    /// polygonal-bounded half-space clip) to fall back to a robust
    /// unbounded plane clip when a difference result looks collapsed
    /// relative to its host. Historically this caught a Linux-specific
    /// Manifold pathology where a wall body clipped by an
    /// `IfcPolygonalBoundedHalfSpace` prism collapsed to a near-empty
    /// result (1 triangle from a 12-triangle host box).
    ///
    /// Rules:
    ///  * An empty result is a legit outcome (cutter contains host) —
    ///    NOT degenerate.
    ///  * A closed-volume result needs at least 4 triangles. Anything
    ///    below that is structurally broken.
    ///  * For hosts with >= 12 triangles (typical IFC solid input), the
    ///    output should retain at least 25 % of the host's triangle
    ///    count when the cutter is partial.
    pub(crate) fn difference_result_looks_degenerate(host: &Mesh, result: &Mesh) -> bool {
        let result_tris = result.indices.len() / 3;
        if result_tris == 0 {
            return false;
        }
        if result_tris < 4 {
            return true;
        }
        let host_tris = host.indices.len() / 3;
        if host_tris >= 12 && result_tris * 4 < host_tris {
            return true;
        }

        // "Wrong piece" check: a difference result MUST be a subset of the
        // host volume, so the result's bounding box has to sit inside the
        // host's. When a malformed cutter (typical: IfcFacetedBrep with
        // inward-pointing face normals) inverts the kernel's
        // inside/outside test, Manifold returns the CUTTER mesh instead —
        // which lives partially or wholly outside the host bbox. House.ifc
        // wall #3448 (a 7 m extrusion clipped by a gable-shaped brep)
        // rendered as the gable triangle alone before this guard.
        let (host_min, host_max) = host.bounds();
        let (res_min, res_max) = result.bounds();
        // 1 % of the host's edge **per axis** — using a single tolerance
        // derived from the longest dimension lets thin walls/plates pass
        // a wrong-piece check on Y/Z that they shouldn't (CodeRabbit
        // review on PR #861). With per-axis slack, a 5 m × 0.4 m × 7 m
        // wall gets ±5 cm tolerance on X, ±4 mm on Y, ±7 cm on Z — so a
        // result that pokes >4 mm past the wall's thickness face is
        // correctly flagged even though it's well within 1 % of the X
        // span.
        let slack = (host_max - host_min).abs() * 0.01;
        if res_min.x + slack.x < host_min.x
            || res_min.y + slack.y < host_min.y
            || res_min.z + slack.z < host_min.z
            || res_max.x > host_max.x + slack.x
            || res_max.y > host_max.y + slack.y
            || res_max.z > host_max.z + slack.z
        {
            return true;
        }
        false
    }

    /// Validate mesh for common issues
    fn validate_mesh(&self, mesh: &Mesh) -> bool {
        // Check for NaN/Inf in positions
        if mesh.positions.iter().any(|v| !v.is_finite()) {
            return false;
        }

        // Check for NaN/Inf in normals
        if mesh.normals.iter().any(|v| !v.is_finite()) {
            return false;
        }

        // Check for valid triangle indices
        let vertex_count = mesh.vertex_count();
        for idx in &mesh.indices {
            if *idx as usize >= vertex_count {
                return false;
            }
        }

        true
    }

    /// Clip an entire mesh against a plane
    pub fn clip_mesh(&self, mesh: &Mesh, plane: &Plane) -> Result<Mesh> {
        record_csg_op(3, mesh.triangle_count(), 0);
        let mut result = Mesh::new();

        // Process each triangle
        let vert_count = mesh.positions.len() / 3;
        for i in (0..mesh.indices.len()).step_by(3) {
            if i + 2 >= mesh.indices.len() {
                break;
            }
            let i0 = mesh.indices[i] as usize;
            let i1 = mesh.indices[i + 1] as usize;
            let i2 = mesh.indices[i + 2] as usize;

            // Bounds check vertex indices
            if i0 >= vert_count || i1 >= vert_count || i2 >= vert_count {
                continue;
            }

            // Get triangle vertices
            let v0 = Point3::new(
                mesh.positions[i0 * 3] as f64,
                mesh.positions[i0 * 3 + 1] as f64,
                mesh.positions[i0 * 3 + 2] as f64,
            );
            let v1 = Point3::new(
                mesh.positions[i1 * 3] as f64,
                mesh.positions[i1 * 3 + 1] as f64,
                mesh.positions[i1 * 3 + 2] as f64,
            );
            let v2 = Point3::new(
                mesh.positions[i2 * 3] as f64,
                mesh.positions[i2 * 3 + 1] as f64,
                mesh.positions[i2 * 3 + 2] as f64,
            );

            let triangle = Triangle::new(v0, v1, v2);

            // Clip triangle
            match self.clip_triangle(&triangle, plane) {
                ClipResult::AllFront(tri) => {
                    // Keep original triangle
                    add_triangle_to_mesh(&mut result, &tri);
                }
                ClipResult::AllBehind => {
                    // Discard triangle
                }
                ClipResult::Split(triangles) => {
                    // Add clipped triangles
                    for tri in triangles {
                        add_triangle_to_mesh(&mut result, &tri);
                    }
                }
            }
        }

        Ok(result)
    }
}

impl Default for ClippingProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Add a triangle to a mesh
fn add_triangle_to_mesh(mesh: &mut Mesh, triangle: &Triangle) {
    let base_idx = mesh.vertex_count() as u32;

    // Calculate normal
    let normal = triangle.normal();

    // Add vertices
    mesh.add_vertex(triangle.v0, normal);
    mesh.add_vertex(triangle.v1, normal);
    mesh.add_vertex(triangle.v2, normal);

    // Add triangle
    mesh.add_triangle(base_idx, base_idx + 1, base_idx + 2);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a box mesh from AABB min/max bounds (12 triangles, 2 per face).
    /// Test-only fixture builder for `subtract_mesh_many_chunks_match_sequential`
    /// below; production code has no AABB-box-to-mesh path (D10 dead-code sweep
    /// deleted `subtract_box`/`aabb_to_mesh`, whose only callers were tests).
    fn aabb_to_mesh(min: Point3<f64>, max: Point3<f64>) -> Mesh {
        let mut mesh = Mesh::with_capacity(8, 36);

        let v0 = Point3::new(min.x, min.y, min.z);
        let v1 = Point3::new(max.x, min.y, min.z);
        let v2 = Point3::new(max.x, max.y, min.z);
        let v3 = Point3::new(min.x, max.y, min.z);
        let v4 = Point3::new(min.x, min.y, max.z);
        let v5 = Point3::new(max.x, min.y, max.z);
        let v6 = Point3::new(max.x, max.y, max.z);
        let v7 = Point3::new(min.x, max.y, max.z);

        add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v2, v1));
        add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v3, v2));
        add_triangle_to_mesh(&mut mesh, &Triangle::new(v4, v5, v6));
        add_triangle_to_mesh(&mut mesh, &Triangle::new(v4, v6, v7));
        add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v4, v7));
        add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v7, v3));
        add_triangle_to_mesh(&mut mesh, &Triangle::new(v1, v2, v6));
        add_triangle_to_mesh(&mut mesh, &Triangle::new(v1, v6, v5));
        add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v1, v5));
        add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v5, v4));
        add_triangle_to_mesh(&mut mesh, &Triangle::new(v3, v7, v6));
        add_triangle_to_mesh(&mut mesh, &Triangle::new(v3, v6, v2));

        mesh
    }

    /// More cutters than MAX_CUTTERS_PER_ARRANGEMENT force the chunked path in
    /// `subtract_mesh_many`; the result must match the sequential subtract chain.
    /// Set difference is order-independent (`host - {all}` equals
    /// `host - {chunk1} - {chunk2} - ...`), so chunking is solid-equivalent. Guards
    /// the chunk boundary (the perf fix for the 86 MB model that stalled the
    /// geometry stream on a ~90-opening host packed into one arrangement).
    #[test]
    fn subtract_mesh_many_chunks_match_sequential() {
        fn vol(m: &Mesh) -> f64 {
            let p = |i: u32| {
                let k = i as usize * 3;
                [
                    m.positions[k] as f64,
                    m.positions[k + 1] as f64,
                    m.positions[k + 2] as f64,
                ]
            };
            let mut v = 0.0;
            for t in m.indices.chunks_exact(3) {
                let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
                v += a[0] * (b[1] * c[2] - c[1] * b[2])
                    - a[1] * (b[0] * c[2] - c[0] * b[2])
                    + a[2] * (b[0] * c[1] - c[0] * b[1]);
            }
            (v / 6.0).abs()
        }
        let csg = ClippingProcessor::new();
        // Long wall + 20 disjoint through-openings (>16 ⇒ 2 chunks at the cap).
        let wall = aabb_to_mesh(Point3::new(0., 0., 0.), Point3::new(40., 3., 0.2));
        let cutters: Vec<Mesh> = (0..20)
            .map(|i| {
                let x = 1.0 + i as f64 * 2.0; // 2 m spacing ⇒ pairwise disjoint
                aabb_to_mesh(Point3::new(x, 1., -0.5), Point3::new(x + 1.0, 2., 0.7))
            })
            .collect();
        let refs: Vec<&Mesh> = cutters.iter().collect();
        let batched = csg
            .subtract_mesh_many(&wall, &refs)
            .expect("chunked subtract must conform");
        let mut seq = wall.clone();
        for c in &cutters {
            seq = csg.subtract_mesh(&seq, c).expect("sequential subtract");
        }
        let (vb, vs) = (vol(&batched), vol(&seq));
        assert!(
            (vb - vs).abs() < 1e-4,
            "chunked volume {vb} != sequential {vs} on 20 disjoint cutters"
        );
        // Sanity: ~20 holes (~0.2 m³ each) actually removed from the ~24 m³ wall.
        assert!(
            vb < vol(&wall) - 3.0,
            "expected ~20 holes removed; wall {} -> {vb}",
            vol(&wall)
        );
    }

    #[test]
    fn test_plane_signed_distance() {
        let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

        assert_eq!(plane.signed_distance(&Point3::new(0.0, 0.0, 5.0)), 5.0);
        assert_eq!(plane.signed_distance(&Point3::new(0.0, 0.0, -5.0)), -5.0);
        assert_eq!(plane.signed_distance(&Point3::new(5.0, 5.0, 0.0)), 0.0);
    }

    #[test]
    fn test_clip_triangle_all_front() {
        let processor = ClippingProcessor::new();
        let triangle = Triangle::new(
            Point3::new(0.0, 0.0, 1.0),
            Point3::new(1.0, 0.0, 1.0),
            Point3::new(0.5, 1.0, 1.0),
        );
        let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

        match processor.clip_triangle(&triangle, &plane) {
            ClipResult::AllFront(_) => {}
            _ => panic!("Expected AllFront"),
        }
    }

    #[test]
    fn test_clip_triangle_all_behind() {
        let processor = ClippingProcessor::new();
        let triangle = Triangle::new(
            Point3::new(0.0, 0.0, -1.0),
            Point3::new(1.0, 0.0, -1.0),
            Point3::new(0.5, 1.0, -1.0),
        );
        let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

        match processor.clip_triangle(&triangle, &plane) {
            ClipResult::AllBehind => {}
            _ => panic!("Expected AllBehind"),
        }
    }

    #[test]
    fn test_clip_triangle_split_one_front() {
        let processor = ClippingProcessor::new();
        let triangle = Triangle::new(
            Point3::new(0.0, 0.0, 1.0),  // Front
            Point3::new(1.0, 0.0, -1.0), // Behind
            Point3::new(0.5, 1.0, -1.0), // Behind
        );
        let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

        match processor.clip_triangle(&triangle, &plane) {
            ClipResult::Split(triangles) => {
                assert_eq!(triangles.len(), 1);
            }
            _ => panic!("Expected Split"),
        }
    }

    #[test]
    fn test_clip_triangle_split_two_front() {
        let processor = ClippingProcessor::new();
        let triangle = Triangle::new(
            Point3::new(0.0, 0.0, 1.0),  // Front
            Point3::new(1.0, 0.0, 1.0),  // Front
            Point3::new(0.5, 1.0, -1.0), // Behind
        );
        let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

        match processor.clip_triangle(&triangle, &plane) {
            ClipResult::Split(triangles) => {
                assert_eq!(triangles.len(), 2);
            }
            _ => panic!("Expected Split with 2 triangles"),
        }
    }

    #[test]
    fn test_triangle_normal() {
        let triangle = Triangle::new(
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(0.0, 1.0, 0.0),
        );

        let normal = triangle.normal();
        assert!((normal.z - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_triangle_area() {
        let triangle = Triangle::new(
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(0.0, 1.0, 0.0),
        );

        let area = triangle.area();
        assert!((area - 0.5).abs() < 1e-6);
    }
}
