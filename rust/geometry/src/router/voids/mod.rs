// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Void (opening) subtraction: 3D CSG, AABB clipping, and triangle-box intersection.

use super::GeometryRouter;
use crate::csg::ClippingProcessor;
use crate::mesh::{SubMesh, SubMeshCollection};
use crate::{Mesh, Point3, Result, TessellationQuality, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix3;
use rustc_hash::FxHashMap;

mod aabb_clip;
mod geom;
mod probe;
mod synthesis;
#[cfg(test)]
mod reveal_tests;

use geom::*;

/// Epsilon for normalizing direction vectors (guards against zero-length).
const NORMALIZE_EPSILON: f64 = 1e-12;
/// Minimum opening volume (m³) below which CSG is skipped (degenerate-void filter).
/// 0.0001 m³ ≈ 0.1 litre — filters artefacts while allowing small real openings (e.g. sleeves).
const MIN_OPENING_VOLUME: f64 = 0.0001;
/// Fraction of pre-CSG triangles the result must retain. CSG outputs with fewer
/// triangles than `pre_count / CSG_TRIANGLE_RETENTION_DIVISOR` are rejected as
/// kernel blowups.
const CSG_TRIANGLE_RETENTION_DIVISOR: usize = 4;
/// Minimum triangle count for a valid CSG result.
const MIN_VALID_TRIANGLES: usize = 4;
/// Maximum wrapper depth when drilling through mapped/boolean items to find an extrusion.
const MAX_EXTRUSION_EXTRACT_DEPTH: usize = 32;



/// Classification of an opening for void subtraction.
#[derive(Clone)]
enum OpeningType {
    /// Rectangular opening with AABB clipping
    /// Fields: (min_bounds, max_bounds, extrusion_direction)
    Rectangular(Point3<f64>, Point3<f64>, Option<Vector3<f64>>),
    /// Diagonal rectangular opening with mesh geometry and a full oriented frame.
    /// The frame preserves roof-window roll, not just the penetration direction.
    DiagonalRectangular(Mesh, OpeningFrame),
    /// Non-rectangular opening (circular, arched, or floor openings with
    /// rotated footprint). Uses full CSG subtraction with the actual mesh
    /// geometry. The AABB + extrusion direction are kept so that callers can
    /// fall back to a rectangular box cut when CSG can't run (issue #635 —
    /// e.g. circular windows whose triangulated profile blows past
    /// `MAX_CSG_POLYGONS_PER_MESH`).
    NonRectangular(Mesh, Point3<f64>, Point3<f64>, Option<Vector3<f64>>),
}

/// World-space basis for an oriented rectangular opening.
#[derive(Clone, Copy)]
struct OpeningFrame {
    depth: Vector3<f64>,
    cross_a: Vector3<f64>,
    cross_b: Vector3<f64>,
}

impl OpeningFrame {
    fn from_depth(depth: Vector3<f64>) -> Option<Self> {
        let depth = depth.try_normalize(NORMALIZE_EPSILON)?;
        let seed = if depth.z.abs() < 0.9 {
            Vector3::new(0.0, 0.0, 1.0)
        } else {
            Vector3::new(0.0, 1.0, 0.0)
        };
        let cross_a = seed.cross(&depth).try_normalize(NORMALIZE_EPSILON)?;
        let cross_b = depth.cross(&cross_a).try_normalize(NORMALIZE_EPSILON)?;
        Some(Self {
            depth,
            cross_a,
            cross_b,
        })
    }

    fn is_axis_aligned(&self) -> bool {
        is_axis_aligned_direction(&self.depth)
            && is_axis_aligned_direction(&self.cross_a)
            && is_axis_aligned_direction(&self.cross_b)
    }
}

/// Pre-computed per-element void subtraction data.
///
/// Building this is expensive: `classify_openings` re-runs `process_element`
/// on each `IfcOpeningElement`, and clipping-plane extraction resolves the
/// element's representation. Once built, it can be reused across every
/// sub-mesh of the same element without re-doing any of that work, so the
/// per-sub-mesh void path in
/// [`GeometryRouter::process_element_with_submeshes_and_voids`] pays the
/// classification cost once per element rather than once per sub-mesh.
pub(super) struct VoidContext {
    /// All classified openings. The diagonal-opening pass needs the raw list
    /// (unmerged) so its per-item box rotation stays accurate.
    openings: Vec<OpeningType>,
    /// Rectangular openings merged into larger boxes to prevent O(2^N)
    /// triangle growth when many adjacent openings tile a surface.
    merged_openings: Vec<OpeningType>,
    /// Parametric placement-frame cut data (host + reconciled opening boxes),
    /// captured only when `rect_fast::param_enabled()`. Drives the analytic fast
    /// path in `apply_void_context`; `None` defers to the exact kernel.
    param: Option<ParamRectCut>,
}

impl VoidContext {
    fn is_noop(&self) -> bool {
        self.openings.is_empty()
    }

    /// True iff every cutter mesh is already in world coords (`origin == 0`). When
    /// so AND the host is world-framed, `apply_void_context` can run the inner CSG
    /// directly (the native / legacy fast path) without cloning the cutters; if any
    /// cutter carries its own per-element origin it must be relativized first.
    fn all_cutters_world_framed(&self) -> bool {
        let world = |o: &OpeningType| match o {
            OpeningType::Rectangular(..) => true,
            OpeningType::DiagonalRectangular(m, _) => m.origin == [0.0, 0.0, 0.0],
            OpeningType::NonRectangular(m, ..) => m.origin == [0.0, 0.0, 0.0],
        };
        self.openings.iter().all(world) && self.merged_openings.iter().all(world)
    }

    /// Return a copy of this context with every opening (raw + merged)
    /// translated by `-origin`, i.e. moved from the world frame into the host's
    /// per-element local frame. Used by [`GeometryRouter::apply_void_context`]
    /// so the cutters share the host's local frame for the CSG — the missing
    /// piece that previously made relativizing only the host silently drop cuts.
    fn relativized_by(&self, origin: [f64; 3]) -> VoidContext {
        VoidContext {
            openings: self.openings.iter().map(|o| o.translated(origin)).collect(),
            merged_openings: self
                .merged_openings
                .iter()
                .map(|o| o.translated(origin))
                .collect(),
            // The parametric path runs in the OUTER apply_void_context on the
            // non-relativized world mesh (it makes its own frame), so the
            // relativized context never uses `param` — drop it.
            param: None,
        }
    }

    /// Oriented boxes of the REAL openings whose cutter mesh is MALFORMED —
    /// self-intersecting tessellated voids carrying garbage "fin" vertices far
    /// from the actual hole (a broken export). The kernel under-cuts such a
    /// cutter, leaving a wall flap bridging the opening; these boxes mark the
    /// region that MUST end up empty so a post-cut pass can drop the flap.
    /// Empty when every cutter is well-formed, so clean hosts are untouched.
    fn malformed_opening_boxes(&self) -> Vec<OpeningBox> {
        self.openings
            .iter()
            .filter_map(|o| match o {
                OpeningType::NonRectangular(m, ..) => opening_obb_if_malformed(m),
                _ => None,
            })
            .collect()
    }
}

/// An oriented box: world centre, orthonormal axes, half-extents along each.
struct OpeningBox {
    center: Vector3<f64>,
    axes: [Vector3<f64>; 3],
    half: [f64; 3],
}

impl OpeningBox {
    /// The thinnest axis — the through-wall / penetration direction.
    fn thin_axis(&self) -> usize {
        (0..3)
            .min_by(|&i, &j| self.half[i].partial_cmp(&self.half[j]).unwrap())
            .unwrap()
    }

    /// A watertight box mesh for the real opening, EXTENDED by `extend` along the
    /// thin (through-wall) axis so it fully penetrates the host, with positions
    /// in the frame whose origin is `origin` (i.e. world − origin). Subtracting
    /// this from the host carves a clean through-opening — see
    /// [`recut_malformed_openings`].
    fn extended_box_mesh(&self, origin: [f64; 3], extend: f64) -> Mesh {
        let thin = self.thin_axis();
        let mut half = self.half;
        half[thin] += extend;
        let corner = |sx: f64, sy: f64, sz: f64| -> Point3<f64> {
            let w = self.center
                + self.axes[0] * (sx * half[0])
                + self.axes[1] * (sy * half[1])
                + self.axes[2] * (sz * half[2]);
            Point3::new(w.x - origin[0], w.y - origin[1], w.z - origin[2])
        };
        // `make_obb_mesh`'s canonical corner order (bit k -> axis k sign).
        let c = [
            corner(-1.0, -1.0, -1.0),
            corner(1.0, -1.0, -1.0),
            corner(1.0, 1.0, -1.0),
            corner(-1.0, 1.0, -1.0),
            corner(-1.0, -1.0, 1.0),
            corner(1.0, -1.0, 1.0),
            corner(1.0, 1.0, 1.0),
            corner(-1.0, 1.0, 1.0),
        ];
        make_obb_mesh(&c)
    }
}

/// Build a watertight box mesh from 8 corners in the canonical order (bit k ->
/// axis k sign). Face winding mirrors `GeometryRouter::make_box_mesh`; normals
/// are derived from the (oriented) geometry rather than hardcoded axes.
fn make_obb_mesh(corners: &[Point3<f64>; 8]) -> Mesh {
    let faces: [[usize; 4]; 6] = [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [2, 3, 7, 6],
        [0, 4, 7, 3],
        [1, 2, 6, 5],
    ];
    let mut m = Mesh::with_capacity(24, 36);
    for idx in &faces {
        let a = corners[idx[0]];
        let b = corners[idx[1]];
        let cc = corners[idx[2]];
        let nrm = (b - a)
            .cross(&(cc - a))
            .try_normalize(1.0e-12)
            .unwrap_or_else(|| Vector3::new(0.0, 0.0, 1.0));
        let base = m.vertex_count() as u32;
        m.add_vertex(corners[idx[0]], nrm);
        m.add_vertex(corners[idx[1]], nrm);
        m.add_vertex(corners[idx[2]], nrm);
        m.add_vertex(corners[idx[3]], nrm);
        m.add_triangle(base, base + 1, base + 2);
        m.add_triangle(base, base + 2, base + 3);
    }
    m
}

/// Compute the clean oriented box of a cutter's REAL opening iff the cutter is
/// MALFORMED (a far-flung garbage-vertex cluster). `None` for a well-formed
/// cutter — clean hosts are never reshaped.
///
/// The real opening is a TIGHT vertex cluster; garbage "fins" sit far away (and
/// a fin running ALONG a long wall stays inside the host AABB, so we cluster
/// INTRINSICALLY, not by host containment). Robust per-axis median centre
/// (garbage is a minority, so the median lands in the real box), sort vertices
/// by distance, cut at the largest RATIO gap in the upper half. No clear gap ->
/// not malformed -> `None`. Principal axes via covariance eigendecomposition
/// (for a box the eigenvectors align with the edges).
fn opening_obb_if_malformed(m: &Mesh) -> Option<OpeningBox> {
    let all: Vec<Vector3<f64>> = m
        .positions
        .chunks_exact(3)
        .map(|p| {
            Vector3::new(
                p[0] as f64 + m.origin[0],
                p[1] as f64 + m.origin[1],
                p[2] as f64 + m.origin[2],
            )
        })
        .collect();
    if all.len() < 8 {
        return None;
    }
    let median_axis = |axis: usize| -> f64 {
        let mut vals: Vec<f64> = all.iter().map(|v| v[axis]).collect();
        vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
        vals[vals.len() / 2]
    };
    let med = Vector3::new(median_axis(0), median_axis(1), median_axis(2));
    let mut dist: Vec<(f64, usize)> = all
        .iter()
        .enumerate()
        .map(|(i, v)| ((v - med).norm(), i))
        .collect();
    dist.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    // The garbage "fins" of these broken cutters sit METRES from the opening
    // (≈9 m here), far beyond any legitimate opening vertex (even a big garage
    // door is ≲3 m). Detect malformity ONLY by an ABSOLUTE far cluster — a
    // vertex `FAR_M` beyond the near cluster AND past a big jump. A clean opening
    // (every vertex within its own footprint, distances uniformly close) never
    // trips this, so it is never reshaped. Anything tighter risks over-cutting a
    // well-formed opening, which is far worse than leaving a rare flap.
    const FAR_M: f64 = 4.0;
    let near_radius = dist[dist.len() / 2].0; // 50th-percentile distance
    let mut split_at = dist.len();
    let mut found = false;
    for i in (dist.len() / 2)..(dist.len() - 1) {
        let gap = dist[i + 1].0 - dist[i].0;
        // a clear gap that lands the far points beyond FAR_M and >3x the near
        // cluster — the bimodal near-opening / far-garbage signature.
        if dist[i + 1].0 > FAR_M
            && dist[i + 1].0 > 3.0 * near_radius.max(1.0e-3)
            && gap > dist[i].0
        {
            split_at = i + 1;
            found = true;
            break;
        }
    }
    if !found {
        return None;
    }
    let inliers: Vec<Vector3<f64>> = dist[..split_at].iter().map(|(_, i)| all[*i]).collect();
    if inliers.len() < 8 {
        return None;
    }
    let n = inliers.len() as f64;
    let mut c = Vector3::zeros();
    for v in &inliers {
        c += v;
    }
    c /= n;
    let mut cov = Matrix3::zeros();
    for v in &inliers {
        let d = v - c;
        cov += d * d.transpose();
    }
    cov /= n;
    let eig = cov.symmetric_eigen();
    let a0 = eig.eigenvectors.column(0).into_owned().try_normalize(1.0e-9)?;
    let a1 = eig.eigenvectors.column(1).into_owned().try_normalize(1.0e-9)?;
    let a2 = a0.cross(&a1).try_normalize(1.0e-9)?;
    let axes = [a0, a1, a2];
    let mut lo = [f64::MAX; 3];
    let mut hi = [f64::MIN; 3];
    for v in &inliers {
        for k in 0..3 {
            let t = v.dot(&axes[k]);
            lo[k] = lo[k].min(t);
            hi[k] = hi[k].max(t);
        }
    }
    let half = [
        (hi[0] - lo[0]) * 0.5,
        (hi[1] - lo[1]) * 0.5,
        (hi[2] - lo[2]) * 0.5,
    ];
    if half.iter().any(|&h| h < 1.0e-3) {
        return None;
    }
    let mid = [
        (hi[0] + lo[0]) * 0.5,
        (hi[1] + lo[1]) * 0.5,
        (hi[2] + lo[2]) * 0.5,
    ];
    let center = axes[0] * mid[0] + axes[1] * mid[1] + axes[2] * mid[2];
    Some(OpeningBox { center, axes, half })
}

/// Repair the kernel's UNDER-cut of malformed (self-intersecting) void cutters —
/// the #1007 "flap" where a wall triangle bridges the opening — by RE-CUTTING
/// each malformed opening with a clean box.
///
/// The self-intersecting cutter leaves the host's original large wall-face
/// triangles spanning the opening (and extending out to the wall edges). The
/// correct repair is to subtract a clean box of the real opening: the exact
/// kernel removes only the opening prism — taking the flap with it — while
/// splitting and re-triangulating the wall AROUND the hole and forming the
/// reveal faces. (A plain triangle drop would also delete the legitimate wall
/// above/below the opening, since those large triangles merely overlap it.)
///
/// World-framed boxes are folded into the result's frame. `subtract_mesh`'s
/// budget guard returns the host un-cut on any failure, so a hard case degrades
/// to "flap remains", never an over-cut. A no-op when `boxes` is empty (every
/// cutter well-formed) — clean hosts are untouched.
fn recut_malformed_openings(result: &mut Mesh, boxes: &[OpeningBox]) {
    if boxes.is_empty() || result.indices.is_empty() {
        return;
    }
    let clipper = ClippingProcessor::new();
    for bx in boxes {
        // Extend 2 m past the opening along the thin axis so the box fully
        // penetrates any normal wall (the subtract only removes box ∩ host).
        let box_mesh = bx.extended_box_mesh(result.origin, 2.0);
        if let Ok(cut) = clipper.subtract_mesh(result, &box_mesh) {
            // A clean box can only remove the opening prism, so it never empties
            // a real wall; ignore a degenerate empty result defensively.
            if !cut.is_empty() {
                let origin = result.origin;
                *result = cut;
                result.origin = origin;
            }
        }
    }
}

/// Express a cutter mesh in the host's local frame: `result = position +
/// mesh.origin - host_origin`, folded in f64 before the f32 store, with the
/// result origin zeroed (the mesh now lives in the shared host frame).
///
/// Honouring the cutter's OWN `origin` keeps a per-element local-frame opening
/// (the wasm default: small positions relative to the opening's AABB centre)
/// PRECISE — it is never first rounded to absolute world f32 and then brought
/// back near the host, so detail openings far from the global origin can't
/// collapse on the coarse world grid (#1310 review). A world-framed cutter
/// (`origin == 0` — the native and ≤100-vertex default) reduces to the plain
/// `position - host_origin` and stays byte-identical.
fn translate_cutter_mesh(mesh: &Mesh, host_origin: [f64; 3]) -> Mesh {
    let o = mesh.origin;
    let mut positions = Vec::with_capacity(mesh.positions.len());
    for c in mesh.positions.chunks_exact(3) {
        positions.push((c[0] as f64 + o[0] - host_origin[0]) as f32);
        positions.push((c[1] as f64 + o[1] - host_origin[1]) as f32);
        positions.push((c[2] as f64 + o[2] - host_origin[2]) as f32);
    }
    Mesh {
        positions,
        normals: mesh.normals.clone(),
        indices: mesh.indices.clone(),
        rtc_applied: mesh.rtc_applied,
        origin: [0.0; 3],
        instance_meta: None,
    }
}

impl OpeningType {
    /// Return a copy translated by `-origin` (world → host-local frame). Bounds
    /// (`Point3`) shift; direction vectors and the oriented `OpeningFrame` are
    /// translation-invariant and pass through unchanged.
    fn translated(&self, origin: [f64; 3]) -> OpeningType {
        let sub = |p: &Point3<f64>| Point3::new(p.x - origin[0], p.y - origin[1], p.z - origin[2]);
        match self {
            OpeningType::Rectangular(min, max, dir) => {
                OpeningType::Rectangular(sub(min), sub(max), *dir)
            }
            OpeningType::DiagonalRectangular(mesh, frame) => {
                OpeningType::DiagonalRectangular(translate_cutter_mesh(mesh, origin), *frame)
            }
            OpeningType::NonRectangular(mesh, min, max, dir) => {
                OpeningType::NonRectangular(translate_cutter_mesh(mesh, origin), sub(min), sub(max), *dir)
            }
        }
    }
}

/// EXACT parametric oriented box of a rectangular extrusion, in WORLD space.
/// `r` columns are the orthonormal world axes (profile-X', profile-Y', extrude);
/// `half` are the half-extents along those axes (XDim/2, YDim/2, Depth/2).
/// Produced by [`GeometryRouter::parametric_rect_probe`].
#[derive(Clone, Copy)]
pub struct RectParam {
    pub r: Matrix3<f64>,
    pub center: Point3<f64>,
    pub half: [f64; 3],
}

/// Captured parametric boxes for a host + its openings (all reconciled to their
/// meshes and sharing the host frame), enabling the analytic placement-frame cut.
/// Built in [`GeometryRouter::build_void_context`] only when `param_enabled()`.
#[derive(Clone)]
struct ParamRectCut {
    host: RectParam,
    openings: Vec<RectParam>,
}

impl GeometryRouter {

    /// Process element with void subtraction (openings)
    /// Process element with voids using optimized plane clipping
    ///
    /// This approach is more efficient than full 3D CSG for rectangular openings:
    /// 1. Get chamfered wall mesh (preserves chamfered corners)
    /// 2. For each opening, use optimized box cutting with internal face generation
    /// 3. Apply any clipping operations (roof clips) from original representation
    ///
    /// Process an element with void subtraction (openings).
    ///
    /// This function handles three distinct cases for cutting openings:
    ///
    /// 1. **Floor/Slab openings** (vertical Z-extrusion): Uses CSG with actual mesh geometry
    ///    because the XY footprint may be rotated relative to the slab orientation.
    ///
    /// 2. **Wall openings** (horizontal X/Y-extrusion, axis-aligned): Uses AABB clipping
    ///    for fast, accurate cutting of rectangular openings.
    ///
    /// 3. **Diagonal wall openings**: Uses AABB clipping without internal face generation
    ///    to avoid rotation artifacts.
    ///
    /// Reveal faces (inner surfaces of the opening holes) are generated as a
    /// post-clipping step for rectangular and diagonal openings.  For diagonal
    /// walls the geometry is computed in a rotated axis-aligned frame and
    /// rotated back, giving correct results for any wall orientation.
    #[inline]
    pub fn process_element_with_voids(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        void_index: &FxHashMap<u32, Vec<u32>>,
    ) -> Result<Mesh> {
        let opening_ids = match void_index.get(&element.id) {
            Some(ids) if !ids.is_empty() => ids,
            _ => {
                return self.process_element(element, decoder);
            }
        };

        let wall_mesh = match self.process_element(element, decoder) {
            Ok(m) => m,
            Err(_) => {
                return self.process_element(element, decoder);
            }
        };

        let mut voided = self.apply_voids_to_mesh(wall_mesh, element, opening_ids, decoder);
        // Clean slivers the CSG cut can introduce at opening seams — same
        // hygiene as the tessellation chokepoints (Mesh::clean_degenerate).
        voided.clean_degenerate();
        // Instancing: a void-cut mesh no longer reproduces its representation's
        // canonical geometry, so it can never be shared. Drop any metadata that
        // rode along from the (pre-cut) mapped item.
        voided.instance_meta = None;
        Ok(voided)
    }

    /// Apply opening subtraction and clipping planes to an already-built mesh.
    ///
    /// Shared entry point used by both the single-mesh path
    /// ([`process_element_with_voids`]) and the per-sub-mesh path
    /// ([`process_element_with_submeshes_and_voids`]). The incoming mesh is
    /// expected to be in the same (world) coordinate space as the element —
    /// i.e. placement already applied — because opening and clip geometry are
    /// resolved in world coordinates.
    ///
    /// Returns the input mesh unchanged when it is invalid or when no
    /// openings/clips apply, so callers never lose their input on a
    /// degenerate opening set.
    pub(super) fn apply_voids_to_mesh(
        &self,
        mesh: Mesh,
        element: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> Mesh {
        let ctx = self.build_void_context(element, opening_ids, decoder);
        self.apply_void_context(mesh, &ctx, element.id)
    }

    /// Classify openings and extract clipping planes for an element.
    ///
    /// This is the expensive half of void subtraction — it decodes every
    /// `IfcOpeningElement` (running `process_element` on each), classifies
    /// them as rectangular / diagonal / non-rectangular, merges adjacent
    /// rectangles, and transforms clipping planes to world space. The
    /// output is reusable across every sub-mesh of the same element.
    pub(super) fn build_void_context(
        &self,
        element: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> VoidContext {
        // NOTE (issue #635): we no longer extract `IfcBooleanClippingResult`
        // planes here. They are applied by `BooleanClippingProcessor::process`
        // when building the input mesh (the wall-inversion fix in
        // `processors/boolean.rs` makes the bounded-prism construction
        // correct per IFC); re-applying them as unbounded planes discarded
        // the polygonal bound and chopped off gable peaks (see
        // `apply_void_context` for the full rationale).
        let openings = self.classify_openings(element, opening_ids, decoder);
        let merged_openings = Self::merge_rectangular_openings(&openings);

        // PARAMETRIC fast-path capture (flag-gated, zero cost when off): probe the
        // host + every opening for an exact rectangular box, reconcile each opening
        // box against its mesh, and require all openings to share the host frame. Any
        // miss -> `None` -> the host defers to the exact kernel.
        let param = if crate::rect_fast::param_enabled() {
            self.capture_param_rect(element, opening_ids, decoder)
        } else {
            None
        };

        VoidContext {
            openings,
            merged_openings,
            param,
        }
    }

    /// Build the parametric-cut data for a host + its openings, or `None` if any
    /// precondition fails (host/opening not a clean rect extrusion, opening box
    /// disagrees with its mesh, or an opening does not share the host frame).
    fn capture_param_rect(
        &self,
        element: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> Option<ParamRectCut> {
        if opening_ids.is_empty() {
            return None;
        }
        let host = self.parametric_rect_probe(element, decoder)?;
        let rt = host.r.transpose();
        let mut openings = Vec::with_capacity(opening_ids.len());
        for &oid in opening_ids {
            let opening = decoder.decode_by_id(oid).ok()?;
            if opening.ifc_type != IfcType::IfcOpeningElement {
                return None;
            }
            // An opening may be a UNION OF RECTANGULAR PRISMS (Tekla multi-solid). Extract
            // every box; each must share the host frame (signed permutation).
            let op_boxes = self.parametric_rect_probe_all(&opening, decoder)?;
            for op in &op_boxes {
                signed_permutation_map(&(rt * op.r), 1.0e-3)?;
            }
            // Reconcile the boxes against the meshed opening by VOLUME: the boxes must
            // account for the opening solid (catches non-rect / overlapping / partial parts).
            if !self.opening_boxes_reconcile(&opening, &op_boxes, decoder) {
                return None;
            }
            openings.extend(op_boxes);
        }
        Some(ParamRectCut { host, openings })
    }

    /// True iff the parametric `boxes` account for the actual meshed opening by VOLUME
    /// (Σ box volume ≈ Σ mesh-shell volume within 3%). For a union of non-overlapping
    /// rectangular prisms (the Tekla multi-solid opening) the mesh volume equals the
    /// box-volume sum; a mismatch flags a non-rect / overlapping / partial part → defer.
    fn opening_boxes_reconcile(
        &self,
        opening: &DecodedEntity,
        boxes: &[RectParam],
        decoder: &mut EntityDecoder,
    ) -> bool {
        if boxes.is_empty() {
            return false;
        }
        let Ok(meshes) = self.get_opening_item_meshes_world(opening, decoder) else {
            return false;
        };
        let mesh_vol: f64 = meshes.iter().map(|m| mesh_signed_volume(m).abs()).sum();
        if mesh_vol < 1.0e-9 {
            return false;
        }
        let box_vol: f64 = boxes
            .iter()
            .map(|b| 8.0 * b.half[0] * b.half[1] * b.half[2])
            .sum();
        let ratio = box_vol / mesh_vol;
        (0.97..1.03).contains(&ratio)
    }

    /// Apply a pre-built `VoidContext` to a single mesh.
    ///
    /// This is the cheap per-mesh half of void subtraction: it re-reads the
    /// mesh bounds (which differ per sub-mesh), extends rectangular openings
    /// along their extrusion axis so they fully penetrate the mesh, then
    /// subtracts every opening through the unified exact-kernel path (with the
    /// per-opening #635 AABB fallback). All the classification work has
    /// already been done in [`GeometryRouter::build_void_context`].
    ///
    /// `element_id` is the IFC product express ID of the host element. Any
    /// `BoolFailure` recorded by the inner CSG kernel is attributed to that
    /// product and stored on the router (drainable via
    /// [`GeometryRouter::take_csg_failures`]). The router's failure log is
    /// the only path failures reach the caller; `apply_void_context` itself
    /// always returns the (possibly un-cut) mesh.
    /// Apply a pre-built `VoidContext`, honouring the host's per-element local
    /// frame.
    ///
    /// When local-frame precision is on, the host mesh arrives stored relative
    /// to `mesh.origin` (small, f32-exact). The CSG must run with host AND
    /// cutters in that SAME frame, or the cutters (resolved in world coords)
    /// won't overlap the local host and every cut silently drops — the
    /// 222692→190201 regression from the first attempt. This wrapper strips the
    /// origin off the host (so the inner body works in a pure origin-0 local
    /// frame with no origin-aware-merge surprises), relativizes the cutters by
    /// the same origin, runs the CSG, then re-stamps the origin on the result so
    /// `world = origin + position` holds for the renderer.
    /// PARAMETRIC analytic fast path: subtract the openings as EXACT parametric boxes
    /// in the host's own placement frame (where the rotated wall + windows are
    /// axis-aligned), using the watertight cellular `rect_fast` cut, then rotate the
    /// result back to world. Frame + extents come from the IFC parametrics (not the
    /// mesh), so the cut is the analytic box-minus-boxes solid — ground-truth exact and
    /// MORE correct than the exact kernel on engulfing-opening walls. Fires only on the
    /// gated subset (`ctx.param` captured; host/opening reconciliation, shared-frame,
    /// in-bounds, no-overlap, watertight self-check); any miss returns `None` → exact
    /// kernel. Deterministic f64 → byte-identical native==wasm.
    fn try_param_rect_cut(&self, mesh: &Mesh, ctx: &VoidContext) -> Option<Mesh> {
        let param = ctx.param.as_ref()?;
        let host = &param.host;
        let rt = host.r.transpose();

        // Host expressed in F (small coords) + reconciliation against the real mesh.
        // ORIGIN-AWARE: the mesh may already be in a per-element local frame (wasm
        // defaults `local_frame_enabled()` ON), where positions are relative to
        // `mesh.origin` (world = origin + position). Frame the cut around
        // `center - origin` so host_f = Rᵀ·(world_vertex - center) either way.
        let o = mesh.origin;
        let eff_center = Point3::new(
            host.center.x - o[0],
            host.center.y - o[1],
            host.center.z - o[2],
        );
        let host_f = rotate_mesh_into_frame(mesh, &rt, &eff_center);
        if host_f.positions.is_empty() {
            return None;
        }
        let mut hmn = [f64::INFINITY; 3];
        let mut hmx = [f64::NEG_INFINITY; 3];
        for c in host_f.positions.chunks_exact(3) {
            for k in 0..3 {
                hmn[k] = hmn[k].min(c[k] as f64);
                hmx[k] = hmx[k].max(c[k] as f64);
            }
        }
        for k in 0..3 {
            let ext = hmx[k] - hmn[k];
            let lo = ext.min(2.0 * host.half[k]);
            let hi = ext.max(2.0 * host.half[k]).max(1.0e-9);
            if lo / hi < 0.99 {
                return None;
            }
        }

        // Opening boxes in F with the in-bounds + through-cut handling.
        let mut boxes: Vec<([f64; 3], [f64; 3])> = Vec::with_capacity(param.openings.len());
        for op in &param.openings {
            let map = signed_permutation_map(&(rt * op.r), 1.0e-3)?;
            let cf = rotate_point(
                &rt,
                op.center.x - host.center.x,
                op.center.y - host.center.y,
                op.center.z - host.center.z,
            );
            // The opening must penetrate along the wall's THIN (thickness) axis. If its
            // extrude axis maps to a length/height axis, extending it across the host
            // would wipe out a full slab — defer that case to the exact kernel.
            let pen = (0..3).find(|&i| map[i].0 == 2)?;
            if host.half[pen] > host.half[thin_axis(&host.half)] * 1.05 {
                return None;
            }
            let mut half_f = [0.0f64; 3];
            for i in 0..3 {
                half_f[i] = op.half[map[i].0];
            }
            // In-bounds: the opening must lie within the wall on the in-face axes; an
            // overrun is a partial intersection where box-clamp ≠ exact mesh-intersect.
            for i in 0..3 {
                if i == pen {
                    continue;
                }
                let tol = host.half[i] * 0.01 + 1.0e-4;
                if cf[i] - half_f[i] < -host.half[i] - tol
                    || cf[i] + half_f[i] > host.half[i] + tol
                {
                    return None;
                }
            }
            // Cut the box AS AUTHORED (it is reconciled to equal the opening void), with a
            // tiny margin on the penetration axis to avoid a flush-face coincidence. The
            // earlier full-thickness override over-cut multi-prism openings (each authored
            // box is a thin slice; extending each to the full thickness removes too much).
            let eps = 1.0e-4;
            let mut bmin = [cf[0] - half_f[0], cf[1] - half_f[1], cf[2] - half_f[2]];
            let mut bmax = [cf[0] + half_f[0], cf[1] + half_f[1], cf[2] + half_f[2]];
            bmin[pen] -= eps;
            bmax[pen] += eps;
            boxes.push((bmin, bmax));
        }

        // No-overlap: overlapping cutter boxes can diverge from the union-subtract.
        for a in 0..boxes.len() {
            for b in (a + 1)..boxes.len() {
                let (amn, amx) = boxes[a];
                let (bmn, bmx) = boxes[b];
                if (0..3).all(|i| amn[i] < bmx[i] - 1.0e-4 && bmn[i] < amx[i] - 1.0e-4) {
                    return None;
                }
            }
        }

        let mut stats = crate::rect_fast::RectFastStats::default();
        let cut_f = crate::rect_fast::subtract_rect_openings(&host_f, &boxes, &mut stats)?;
        self.record_rect_fast(&stats);
        let merged = crate::csg::ClippingProcessor::consolidate_coplanar(cut_f);
        // Emit as a local-frame mesh (small positions + origin), then run the SAME
        // hygiene the production output applies — in the small frame, where it is
        // precise — so the self-check sees exactly what downstream will keep.
        let mut out = rotate_mesh_from_frame(&merged, &host.r, &host.center);
        out.clean_degenerate();

        // Self-check: never emit a non-watertight cut; defer to the exact kernel.
        if !param_cut_watertight(&out) {
            return None;
        }
        crate::rect_fast::param_record_fire();
        Some(out)
    }

    pub(super) fn apply_void_context(
        &self,
        mut mesh: Mesh,
        ctx: &VoidContext,
        element_id: u32,
    ) -> Mesh {
        // PARAMETRIC fast path (flag-gated). ORIGIN-AWARE: it handles both the world
        // mesh (origin 0, native default) AND a per-element local-frame mesh (origin != 0,
        // the wasm default — the precision-critical case this path is FOR), since it
        // builds its own frame from the parametrics. Any miss falls through to the exact
        // kernel below unchanged.
        if crate::rect_fast::param_enabled() {
            if let Some(fast) = self.try_param_rect_cut(&mesh, ctx) {
                return fast;
            }
        }

        let origin = mesh.origin;
        if origin == [0.0, 0.0, 0.0] && ctx.all_cutters_world_framed() {
            // Legacy/world frame on host AND cutters: no relativization needed.
            return self.apply_void_context_inner(mesh, ctx, element_id);
        }
        // Work entirely in the host's local frame (origin 0 on every operand).
        // `relativized_by` folds each cutter's OWN origin and subtracts the host
        // origin in f64, so a per-element local-frame opening lands at the host
        // precisely. This also covers a host that snapped to origin 0 while its
        // openings did not (origin == 0 but cutters are local-framed).
        mesh.origin = [0.0, 0.0, 0.0];
        let local_ctx = ctx.relativized_by(origin);
        let mut result = self.apply_void_context_inner(mesh, &local_ctx, element_id);
        result.origin = origin;
        result
    }

    /// Try the analytic rectangular-opening fast path. Returns the watertight
    /// cut mesh iff EVERY merged opening is an axis-aligned `Rectangular`
    /// through-cut and the host is a clean axis-aligned box; otherwise `None`
    /// (→ the exact kernel handles it). A mixed opening set defers the whole
    /// host rather than composing analytic + exact cuts.
    fn try_rect_fast(&self, host: &Mesh, ctx: &VoidContext) -> Option<Mesh> {
        let (wmn, wmx) = host.bounds();
        let wall_min = Point3::new(wmn.x as f64, wmn.y as f64, wmn.z as f64);
        let wall_max = Point3::new(wmx.x as f64, wmx.y as f64, wmx.z as f64);
        let mut boxes: Vec<([f64; 3], [f64; 3])> =
            Vec::with_capacity(ctx.merged_openings.len());
        for op in &ctx.merged_openings {
            match op {
                OpeningType::Rectangular(omn, omx, dir) => {
                    let (fmn, fmx) = match dir {
                        Some(d) => self.extend_opening_along_direction(
                            *omn, *omx, wall_min, wall_max, *d,
                        ),
                        None => (*omn, *omx),
                    };
                    boxes.push(([fmn.x, fmn.y, fmn.z], [fmx.x, fmx.y, fmx.z]));
                }
                _ => return None,
            }
        }
        let mut stats = crate::rect_fast::RectFastStats::default();
        let out = crate::rect_fast::subtract_rect_openings(host, &boxes, &mut stats);
        self.record_rect_fast(&stats);
        // The cellular cut conformingly splits EVERY face by ALL grid lines (so
        // adjacent cells share edges → watertight), which over-fragments faces an
        // opening doesn't reach. Run the result through the SAME coplanar merge
        // the exact path uses (i_overlay union per plane) to collapse those back
        // to minimal triangles — keeps it watertight and un-bloated.
        out.map(crate::csg::ClippingProcessor::consolidate_coplanar)
    }

    /// Cut a plan-rotated wall's openings in the wall's own axis-aligned,
    /// origin-centred frame (issue #1167). Returns `None` (caller uses the
    /// world path) unless an opening supplies a non-axis-aligned, ~horizontal
    /// depth axis (a vertical wall rotated in plan) and every opening carries a
    /// cutter mesh.
    ///
    /// In the wall frame the host and its openings are axis-aligned and near the
    /// origin, so the exact subtract runs in the clean, f32-precise regime a
    /// straight wall enjoys — clean-box openings even reclassify to the
    /// watertight `rect_fast` path. Curved / brep openings keep their mesh and
    /// are subtracted there too. The result is rotated back; the orthonormal,
    /// origin-centred round-trip is identity for untouched geometry. Recursing
    /// into [`Self::apply_void_context_inner`] is safe: in the frame every
    /// opening's depth is +Z (axis-aligned), so this guard returns `None` on the
    /// inner call.
    fn try_cut_wall_local_frame(
        &self,
        mesh: &Mesh,
        ctx: &VoidContext,
        element_id: u32,
    ) -> Option<Mesh> {
        if ctx.merged_openings.is_empty() {
            return None;
        }
        let depth_of = |op: &OpeningType| -> Option<Vector3<f64>> {
            match op {
                OpeningType::DiagonalRectangular(_, f) => Some(f.depth),
                OpeningType::NonRectangular(_, _, _, d) => *d,
                OpeningType::Rectangular(_, _, d) => *d,
            }
        };
        // Define the wall frame from the first opening whose depth is a
        // genuinely rotated, ~horizontal axis. Axis-aligned walls find none and
        // keep their (unchanged) world path.
        let axes = ctx
            .merged_openings
            .iter()
            .filter_map(depth_of)
            .find(|d| !is_axis_aligned_direction(d) && d.z.abs() <= 0.2)
            .and_then(wall_frame_from_depth)?;

        // AABB-only `Rectangular` openings can't be rotated into the frame; a
        // plan-rotated wall never has them (they'd be diagonal), so bail.
        if ctx
            .merged_openings
            .iter()
            .any(|op| matches!(op, OpeningType::Rectangular(..)))
        {
            return None;
        }

        let (mn, mx) = mesh.bounds();
        let center = Vector3::new(
            ((mn.x + mx.x) * 0.5) as f64,
            ((mn.y + mx.y) * 0.5) as f64,
            ((mn.z + mx.z) * 0.5) as f64,
        );
        let host_local = mesh_to_frame(mesh, &axes, center);

        let z = Vector3::new(0.0, 0.0, 1.0);
        let mut local_openings: Vec<OpeningType> = Vec::with_capacity(ctx.merged_openings.len());
        for op in &ctx.merged_openings {
            let cutter = match op {
                OpeningType::DiagonalRectangular(m, _) => m,
                OpeningType::NonRectangular(m, _, _, _) => m,
                OpeningType::Rectangular(..) => return None,
            };
            let (lmn, lmx) = project_aabb_in_frame(cutter, &axes, center)?;
            let in_frame =
                |v: Vector3<f64>| Vector3::new(v.dot(&axes[0]), v.dot(&axes[1]), v.dot(&axes[2]));
            // The cutter's own penetration (depth) axis expressed in the wall
            // frame. Drives both the alignment test and — for the exact fallback
            // — the cap-extension direction, which MUST stay faithful to THIS
            // cutter: hardcoding the wall normal would push a misaligned
            // opening's flush/short cap along the wrong axis and carve the wrong
            // prism (#1270 review).
            let frame_depth = match op {
                OpeningType::DiagonalRectangular(_, f) => Some(in_frame(f.depth)),
                OpeningType::NonRectangular(_, _, _, d) => d.map(in_frame),
                OpeningType::Rectangular(..) => None,
            };
            // Whether THIS opening's own oriented box is axis-aligned in the
            // wall frame. The frame is seeded from the FIRST rotated opening
            // (#1167); a second opening tilted differently *in plane* is NOT
            // axis-aligned here, so projecting its frame AABB would over-cut it
            // (#1259 review). Only a clean box whose full frame aligns with the
            // wall frame may take the fast rectangular cut; everything else —
            // brep/curved voids and frame-misaligned boxes alike — keeps its
            // exact (un-rotated, centred) mesh for the subtract.
            let frame_aligned = match op {
                OpeningType::DiagonalRectangular(_, f) => {
                    is_axis_aligned_direction(&in_frame(f.depth))
                        && is_axis_aligned_direction(&in_frame(f.cross_a))
                        && is_axis_aligned_direction(&in_frame(f.cross_b))
                }
                _ => false,
            };
            if frame_aligned {
                local_openings.push(OpeningType::Rectangular(lmn, lmx, Some(z)));
            } else {
                let mesh_local = mesh_to_frame(cutter, &axes, center);
                // Keep this cutter's true depth in the frame; fall back to the
                // wall normal (+Z) only when the opening carried no direction.
                let dir = frame_depth.unwrap_or(z);
                local_openings.push(OpeningType::NonRectangular(mesh_local, lmn, lmx, Some(dir)));
            }
        }
        let local_ctx = VoidContext {
            merged_openings: Self::merge_rectangular_openings(&local_openings),
            openings: local_openings,
            // The local-frame recursion never re-captures the parametric cut
            // (issue #1209): it operates on already-classified openings, so the
            // analytic `param` path is irrelevant here — defer to the exact path.
            param: None,
        };

        let result_local = self.apply_void_context_inner(host_local, &local_ctx, element_id);
        Some(mesh_from_frame(&result_local, &axes, center))
    }

    // `host_mutated` is set just before an early `break`, so the final write is
    // intentionally never read back; keep the flag for readability of the branch.
    #[allow(unused_assignments)]
    fn apply_void_context_inner(&self, mesh: Mesh, ctx: &VoidContext, element_id: u32) -> Mesh {
        // Capture the input triangle count + bounds so the per-host
        // diagnostic can flag the "cuts attempted but produced no
        // change" case — the silent-no-op signature when an opening
        // box doesn't intersect the host mesh.
        let tris_before = mesh.triangle_count();
        let host_bounds_capture = {
            let (mn, mx) = mesh.bounds();
            ((mn.x, mn.y, mn.z), (mx.x, mx.y, mx.z))
        };
        if ctx.is_noop() {
            return mesh;
        }

        // LOCAL-FRAME CUT (issue #1167): a vertical wall rotated in plan is cut
        // in its own axis-aligned, origin-centred frame — where the exact
        // subtract is clean and f32-precise — then the result is rotated back.
        // The world-space tilted cut at large coordinates over-cuts and
        // fragments badly. Scoped to plan-rotated walls; everything else falls
        // through to the world path unchanged.
        if let Some(cut) = self.try_cut_wall_local_frame(&mesh, ctx, element_id) {
            return cut;
        }

        let clipper = ClippingProcessor::new();
        // ROOT-CAUSE FIX (issue #1007, host #1112): correct f32 facet jitter on
        // the host triangle soup BEFORE the exact-kernel cut. A faceted-BREP
        // roof slope authored as ONE flat plane comes back from the f32 import
        // with adjacent facets ~0.09° non-coplanar. That jitter (a) splits the
        // slope into many one-triangle plane buckets in `consolidate_coplanar`
        // — a single-triangle bucket bypasses the CDT and is emitted as a 25:1
        // far-corner sliver fan — and (b) blocks clean coalescing of the cut
        // hole. Welding near-coplanar adjacent facets (≤0.15°, well below any
        // real roof pitch) to a single least-squares plane makes the slope
        // EXACTLY coplanar, so the cut emits one CDT-refined region (rim sliver
        // gone) with a clean opening hole. Deterministic + watertight + grid-
        // snapped; a no-op for already-planar extrusion hosts.
        let mut result = crate::facet_weld::weld_near_coplanar_facets(&mesh);

        // ANALYTIC FAST PATH: an axis-aligned box host whose openings are ALL
        // axis-aligned rectangular through-cuts is subtracted analytically
        // (`rect_fast`), skipping the exact mesh-arrangement kernel — the
        // ~80 s memory-bandwidth-bound void-cut window's dominant cost. Pure
        // optimization: any precondition miss (non-box host, mixed/non-rect
        // openings, near-edge feature) returns `None` and the host falls through
        // to the exact path below unchanged. Fired BEFORE the dense-host
        // subdivision (that workaround is only for the exact kernel).
        if crate::rect_fast::enabled() {
            if let Some(fast) = self.try_rect_fast(&result, ctx) {
                // Same per-host cut-effect snapshot the exact path records below,
                // so fast-path hosts aren't missing from the diagnostics.
                self.record_host_cut_effect(
                    element_id,
                    tris_before,
                    fast.triangle_count(),
                    ctx.merged_openings.len(),
                    host_bounds_capture,
                );
                return fast;
            }
        }

        // OPENING-DENSE HOST REFINEMENT: when many openings target the same host
        // (a window wall is usually 2 big face-triangles per side), every cut's
        // intersection segments pile onto those few triangles — the exact
        // arrangement then re-triangulates a single triangle carrying dozens of
        // constraints (O(k²)), and the batched N-ary subtract leaves unrecovered
        // constraints and degrades to the O(N²) sequential path. Pre-subdividing
        // the host spreads the segments across many small triangles (small k each)
        // so the batched cut recovers. `consolidate_coplanar` re-triangulates each
        // coplanar group afterwards, so the temporary interior vertices don't
        // bloat the final mesh. Levels are scaled to opening count and capped.
        let n_openings = ctx.merged_openings.len();
        if n_openings >= 8 {
            // Just enough subdivision that each host triangle carries only a few
            // intersection segments, so the batched N-ary subtract RECOVERS rather
            // than degrading to the O(N²) sequential path — that recovery is the
            // win (≈10× on the densest walls), not the per-triangle segment count
            // itself. Over-subdividing is counter-productive: the extra triangles
            // cost more in the arrangement than the spreading saves (level 3 was
            // ~3× slower than level 1 on a 14-opening wall). Aim for ≳ a handful of
            // host triangles per opening, capped at 2 levels.
            let host_tris = result.triangle_count().max(1);
            let target = 4 * n_openings;
            let mut levels = 0usize;
            while host_tris * (1usize << (2 * (levels + 1))) < target && levels < 2 {
                levels += 1;
            }
            // A COARSE host (a box wall is ~12 triangles) still needs one split
            // even when the next level would overshoot the target; an ALREADY-dense
            // host (e.g. a faceted-BREP wall whose triangle count already meets the
            // target) is left untouched — extra geometry there only slows the cut.
            if levels == 0 && host_tris < target {
                levels = 1;
            }
            if levels > 0 {
                result = result.subdivided(levels);
            }
        }

        let (wall_min_f32, wall_max_f32) = result.bounds();
        let wall_min = Point3::new(
            wall_min_f32.x as f64,
            wall_min_f32.y as f64,
            wall_min_f32.z as f64,
        );
        let wall_max = Point3::new(
            wall_max_f32.x as f64,
            wall_max_f32.y as f64,
            wall_max_f32.z as f64,
        );

        let wall_valid = !result.is_empty()
            && result.positions.iter().all(|&v| v.is_finite())
            && result.triangle_count() >= 4;

        if !wall_valid {
            return result;
        }

        // NOTE: there is deliberately NO per-element CSG operation budget here.
        // The BSP-era `MAX_CSG_OPERATIONS = 10` cap silently skipped the 11th+
        // opening (it `continue`d past BOTH the exact subtract AND the #635 AABB
        // fallback), which is exactly the regression `csg_void_test::
        // many_tessellated_box_openings_are_all_cut` pins (history: #413/#439).
        // On the unified exact path every opening is a cheap box-vs-host cut, so
        // a budget-skipped opening is a correctness bug, not a perf guard.

        // UNIFIED EXACT PATH (PART B): every opening — axis-aligned RECTANGULAR
        // included — is now subtracted by the exact mesh kernel, NOT the legacy
        // Sutherland-Hodgman AABB clip. A `Rectangular` opening is materialised as
        // a PENETRATING box mesh (its bounds extended through the wall along the
        // extrusion axis by `extend_opening_along_direction`, so both caps poke past
        // the host ⇒ a transversal cut with no flush-cap sliver — the same robust
        // condition PART A guarantees for tilted openings). The exact subtract emits
        // the void's interior reveal faces itself, so the explicit reveal/recess
        // quad generators are no longer needed on this path.
        //
        // `synth_rect` owns the synthesised box meshes so they outlive the loop's
        // borrowed `&OpeningType`s below.
        let mut synth_rect: Vec<OpeningType> = Vec::new();
        let mut non_rect_openings: Vec<&OpeningType> = Vec::new();
        for opening in &ctx.merged_openings {
            match opening {
                OpeningType::Rectangular(open_min, open_max, extrusion_dir) => {
                    // Penetration axis: the authored extrusion dir when present,
                    // else inferred from how the box pierces the host (issue
                    // #1337). Carrying a concrete dir downstream keeps the
                    // through-host cap-flush extension off the opening's thinnest
                    // (in-plane) axis for deep cutters.
                    let dir = extrusion_dir.unwrap_or_else(|| {
                        infer_box_penetration_dir(open_min, open_max, &wall_min, &wall_max)
                    });
                    // Only openings with an AUTHORED extrusion dir were extended
                    // here before; keep the synthesized box identical for the
                    // dirless case (the inferred dir only steers the later
                    // through-host extension, not the box bounds).
                    let (final_min, final_max) = if extrusion_dir.is_some() {
                        self.extend_opening_along_direction(
                            *open_min, *open_max, wall_min, wall_max, dir,
                        )
                    } else {
                        (*open_min, *open_max)
                    };
                    let box_mesh = Self::make_box_mesh(final_min, final_max);
                    synth_rect.push(OpeningType::NonRectangular(
                        box_mesh,
                        final_min,
                        final_max,
                        Some(dir),
                    ));
                }
                // A MALFORMED (self-intersecting) tessellated cutter is NOT cut
                // here: its messy mesh under-cuts the opening, and double-cutting
                // it (here AND in the clean-box `recut_malformed_openings` pass)
                // leaves overlapping sliver "shards" in the reveals. Skip it; the
                // recut performs the single, clean box cut for these openings.
                OpeningType::NonRectangular(m, ..) if opening_obb_if_malformed(m).is_some() => {}
                other => non_rect_openings.push(other),
            }
        }
        let all_openings: Vec<&OpeningType> =
            synth_rect.iter().chain(non_rect_openings.iter().copied()).collect();

        // DISJOINT-CUTTER BATCHING: group cutters whose pad-inflated
        // AABBs are pairwise disjoint and subtract each group in ONE conforming
        // arrangement (`ClippingProcessor::subtract_mesh_many`). Sequential
        // per-opening subtraction re-arranges the whole (growing) host once per
        // cutter, and each intermediate f64→f32→snap round-trip re-jitters
        // carve vertices off shared planes so cut N+1 re-cracks what cut N
        // reconciled — many-void walls' compounding open edges and the
        // 16-void slab's ~3.5 s cost. Batching admits only openings that pass
        // the SAME guards as the sequential loop plus per-component
        // watertightness (#2176: an open component poisons the group's ray
        // parity); per-component outward orientation happens inside
        // `mesh_bridge::subtract_many`. Singletons and any group whose batched
        // cut fails its guards — or the kernel's conformity gate:
        // `subtract_mesh_many` rejects a group whose N-ary arrangement left an
        // unrecovered constraint — stay unconsumed and fall through to the
        // per-opening sequential loop below with its full #635 fallback /
        // engulf / redundant-void machinery.
        let mut batch_consumed: Vec<bool> = vec![false; all_openings.len()];
        // Disjoint groups of opening indices (len ≥ 2 only); each is cut
        // INLINE at its first member's position in the sequential loop below,
        // so the relative order of batched vs sequential cutters matches the
        // pure sequential pass — only the order WITHIN a group (mutually
        // disjoint cutters, the provably order-free case) is collapsed.
        let mut batch_groups: Vec<Vec<(usize, Mesh)>> = Vec::new();
        let mut batch_group_of: FxHashMap<usize, usize> = FxHashMap::default();
        // Set on every successful cut; while false, a group's admission-time
        // extended cutters are still valid and reused verbatim.
        let mut host_mutated = false;
        if all_openings.len() >= 2 {
            // Inflation pad: ≥ 2×(promote band 8·2⁻¹⁶ ≈ 122 µm + snap radius);
            // 1 mm is conservative and far below any real opening separation.
            // Touching/overlapping cutters land in DIFFERENT groups, cut in
            // sequence — overlap degrades gracefully to sequential behavior.
            const BATCH_PAD: f64 = 1.0e-3;
            struct Cand {
                idx: usize,
                /// The admission-time extended cutter (host PRE-cut). Reused at
                /// cut time while the host is still unmutated — the common case
                /// (groups are cut at their FIRST member, usually before any
                /// sequential cut) — so extension isn't paid twice.
                mesh: Mesh,
                lo: [f64; 3],
                hi: [f64; 3],
            }
            let mut cands: Vec<Cand> = Vec::new();
            for (idx, opening) in all_openings.iter().enumerate() {
                let norm: Option<(&Mesh, Option<Vector3<f64>>)> = match **opening {
                    OpeningType::Rectangular(..) => None,
                    OpeningType::DiagonalRectangular(ref m, ref f) => Some((m, Some(f.depth))),
                    OpeningType::NonRectangular(ref m, _, _, ref d) => Some((m, *d)),
                };
                let Some((opening_mesh, extrusion_dir)) = norm else { continue };
                // Same admission guards as the sequential loop.
                let opening_valid = !opening_mesh.is_empty()
                    && opening_mesh.positions.iter().all(|&v| v.is_finite())
                    && opening_mesh.positions.len() >= 9;
                if !opening_valid {
                    continue;
                }
                let (result_min, result_max) = result.bounds();
                let (omn, omx) = opening_mesh.bounds();
                let no_overlap = omx.x < result_min.x
                    || omn.x > result_max.x
                    || omx.y < result_min.y
                    || omn.y > result_max.y
                    || omx.z < result_min.z
                    || omn.z > result_max.z;
                if no_overlap {
                    continue;
                }
                let open_vol = (omx.x - omn.x) as f64
                    * (omx.y - omn.y) as f64
                    * (omx.z - omn.z) as f64;
                if open_vol < MIN_OPENING_VOLUME {
                    continue;
                }
                let depth_dir = extrusion_dir
                    .filter(|d| d.norm() > NORMALIZE_EPSILON)
                    .unwrap_or_else(|| opening_mesh_thinnest_axis_dir(opening_mesh));
                let ext =
                    Self::extend_opening_mesh_through_host(opening_mesh, &result, depth_dir);
                // #2176: only per-component-watertight solids may join a group.
                if !mesh_is_closed_exact(&ext) {
                    continue;
                }
                let (lo, hi) = ext.bounds();
                // Engulf-class exclusion: a cutter whose extended AABB covers
                // the whole host on EVERY axis (3% slack, the sequential
                // engulf test) stays on the sequential path, where the
                // near-engulf and redundant-void guards live — batched it can
                // shave the host's outer shell (the #559171-family residual).
                let engulfs = {
                    let tol = 0.03_f64;
                    let covers = |omin: f64, omax: f64, wmin: f64, wmax: f64| {
                        let slack = (wmax - wmin).abs().max(1.0e-9) * tol;
                        omin <= wmin + slack && omax >= wmax - slack
                    };
                    covers(lo.x as f64, hi.x as f64, wall_min.x, wall_max.x)
                        && covers(lo.y as f64, hi.y as f64, wall_min.y, wall_max.y)
                        && covers(lo.z as f64, hi.z as f64, wall_min.z, wall_max.z)
                };
                if engulfs {
                    continue;
                }
                cands.push(Cand {
                    idx,
                    mesh: ext,
                    lo: [
                        lo.x as f64 - BATCH_PAD,
                        lo.y as f64 - BATCH_PAD,
                        lo.z as f64 - BATCH_PAD,
                    ],
                    hi: [
                        hi.x as f64 + BATCH_PAD,
                        hi.y as f64 + BATCH_PAD,
                        hi.z as f64 + BATCH_PAD,
                    ],
                });
            }
            // Greedy disjoint grouping, deterministic in opening order: a
            // candidate joins the first group whose EVERY member's inflated
            // AABB is disjoint from its own.
            let mut groups: Vec<Vec<usize>> = Vec::new();
            'cand: for ci in 0..cands.len() {
                for g in groups.iter_mut() {
                    let disjoint_from_all = g.iter().all(|&cj| {
                        let (a, b) = (&cands[ci], &cands[cj]);
                        a.hi[0] < b.lo[0]
                            || a.lo[0] > b.hi[0]
                            || a.hi[1] < b.lo[1]
                            || a.lo[1] > b.hi[1]
                            || a.hi[2] < b.lo[2]
                            || a.lo[2] > b.hi[2]
                    });
                    if disjoint_from_all {
                        g.push(ci);
                        continue 'cand;
                    }
                }
                groups.push(vec![ci]);
            }
            for g in &groups {
                if g.len() < 2 {
                    continue; // singleton: sequential loop handles it (full guards)
                }
                let gid = batch_groups.len();
                for &ci in g {
                    batch_group_of.insert(cands[ci].idx, gid);
                }
                batch_groups
                    .push(g.iter().map(|&ci| (cands[ci].idx, cands[ci].mesh.clone())).collect());
            }
        }

        for (opening_idx, opening) in all_openings.iter().enumerate() {
            if batch_consumed[opening_idx] {
                continue; // already cut as part of a batched disjoint group
            }
            // Batched group cut, attempted ONCE, inline at the group's first
            // member — so the relative order of batched vs sequential cutters
            // matches the pure sequential pass. On any failure (admission,
            // guards, or the kernel's conformity gate) the members fall back
            // to the per-opening sequential path below.
            if let Some(&gid) = batch_group_of.get(&opening_idx) {
                let members = std::mem::take(&mut batch_groups[gid]);
                if members.len() >= 2 {
                    // While the host is unmutated, the admission-time extended
                    // cutters (built against this exact host) are reused as-is;
                    // after any cut, members are re-extended against the
                    // CURRENT host — matching the sequential loop's reference,
                    // which extends each cutter against the (k−1)-cut host.
                    let mut extended: Vec<(usize, Mesh)> = Vec::with_capacity(members.len());
                    let mut admissible = true;
                    if !host_mutated {
                        extended = members;
                    } else {
                        for &(m_idx, _) in &members {
                            let norm: Option<(&Mesh, Option<Vector3<f64>>)> =
                                match *all_openings[m_idx] {
                                    OpeningType::Rectangular(..) => None,
                                    OpeningType::DiagonalRectangular(ref m, ref f) => {
                                        Some((m, Some(f.depth)))
                                    }
                                    OpeningType::NonRectangular(ref m, _, _, ref d) => {
                                        Some((m, *d))
                                    }
                                };
                            let Some((opening_mesh, extrusion_dir)) = norm else {
                                admissible = false;
                                break;
                            };
                            let depth_dir = extrusion_dir
                                .filter(|d| d.norm() > NORMALIZE_EPSILON)
                                .unwrap_or_else(|| opening_mesh_thinnest_axis_dir(opening_mesh));
                            let ext = Self::extend_opening_mesh_through_host(
                                opening_mesh,
                                &result,
                                depth_dir,
                            );
                            // the re-extended cutter must stay watertight (#2176)
                            if !mesh_is_closed_exact(&ext) {
                                admissible = false;
                                break;
                            }
                            extended.push((m_idx, ext));
                        }
                    }
                    if admissible {
                        let cutters: Vec<&Mesh> = extended.iter().map(|(_, m)| m).collect();
                        let tri_before = result.triangle_count();
                        if let Ok(csg_result) = clipper.subtract_mesh_many(&result, &cutters) {
                            let min_tris = (tri_before / CSG_TRIANGLE_RETENTION_DIVISOR)
                                .max(MIN_VALID_TRIANGLES);
                            let changed = csg_result.triangle_count() != tri_before;
                            if !csg_result.is_empty()
                                && csg_result.triangle_count() >= min_tris
                                && changed
                            {
                                result = csg_result;
                                host_mutated = true;
                                for &(m_idx, _) in &extended {
                                    batch_consumed[m_idx] = true;
                                }
                            }
                        }
                    }
                }
                if batch_consumed[opening_idx] {
                    continue; // this opening was cut with its group
                }
            }
            // Normalize both exact-subtract variants into the same (mesh, min,
            // max, dir) shape. `DiagonalRectangular` (a clean but tilted box —
            // e.g. a roof-slope window or a slanted roof opening, #1007 defect B)
            // is a REAL solid cutter, so it MUST be subtracted exactly, never
            // approximated by a frame-rotated AABB: that legacy path
            // (`apply_diagonal_openings`) tore the host (101 boundary edges) and
            // left the void uncut. Route it through the same exact-mesh subtract
            // as `NonRectangular`; the kernel cuts the tilted box cleanly
            // (winding-robust after the defect-A orient-outward fix). The
            // mesh-bounds AABB + frame-depth direction still seed the #635
            // fallback, which only fires if the exact subtract no-ops.
            let normalized: Option<(&Mesh, Point3<f64>, Point3<f64>, Option<Vector3<f64>>)> =
                match *opening {
                    OpeningType::Rectangular(..) => None,
                    OpeningType::DiagonalRectangular(ref opening_mesh, ref frame) => {
                        let (mn, mx) = opening_mesh.bounds();
                        Some((
                            opening_mesh,
                            Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
                            Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
                            Some(frame.depth),
                        ))
                    }
                    OpeningType::NonRectangular(
                        ref opening_mesh,
                        ref open_min_pt,
                        ref open_max_pt,
                        ref extrusion_dir,
                    ) => Some((opening_mesh, *open_min_pt, *open_max_pt, *extrusion_dir)),
                };
            if let Some((opening_mesh, open_min_pt, open_max_pt, extrusion_dir)) = normalized {
                let open_min_pt = &open_min_pt;
                let open_max_pt = &open_max_pt;
                {
                    let opening_valid = !opening_mesh.is_empty()
                        && opening_mesh.positions.iter().all(|&v| v.is_finite())
                        && opening_mesh.positions.len() >= 9;

                    if !opening_valid {
                        continue;
                    }

                    let (result_min, result_max) = result.bounds();
                    let (open_min_f32, open_max_f32) = opening_mesh.bounds();
                    let no_overlap = open_max_f32.x < result_min.x
                        || open_min_f32.x > result_max.x
                        || open_max_f32.y < result_min.y
                        || open_min_f32.y > result_max.y
                        || open_max_f32.z < result_min.z
                        || open_min_f32.z > result_max.z;
                    if no_overlap {
                        continue;
                    }

                    let open_vol = (open_max_f32.x - open_min_f32.x)
                        * (open_max_f32.y - open_min_f32.y)
                        * (open_max_f32.z - open_min_f32.z);
                    // The 0.1 L volume floor filtered legacy-BSP CSG artefacts but
                    // also drops genuine small openings — bolt holes / sleeves in
                    // thin plates. At the two highest quality levels keep those
                    // holes (the exact kernel is stable on small cutters); only
                    // reject numerically degenerate cutters there. (issue #976)
                    let min_open_vol = match self.tessellation_quality {
                        TessellationQuality::High | TessellationQuality::Highest => 1e-9_f32,
                        _ => MIN_OPENING_VOLUME as f32,
                    };
                    if open_vol < min_open_vol {
                        continue;
                    }

                    // ENGULFING-SOLID VOID: when this opening's real solid
                    // CONTAINS the whole host, the exact subtract no-ops on the
                    // coincident shared faces and returns the host unchanged in
                    // volume (a spurious solid where the opening should be). A
                    // cheap AABB-engulf pre-check (false for an ordinary opening,
                    // which spans the host on at most its thickness axis) gates
                    // the O(host_v · opening_t) containment scan, which confirms
                    // TRUE solid containment — so a void whose AABB engulfs the
                    // host while its real profile excludes it is not affected.
                    // On a hit the host is fully consumed.
                    let aabb_engulfs = {
                        let tol = 0.03_f32;
                        let covers = |omin: f32, omax: f32, hmin: f32, hmax: f32| {
                            let slack = (hmax - hmin).abs().max(1.0e-9) * tol;
                            omin <= hmin + slack && omax >= hmax - slack
                        };
                        covers(open_min_f32.x, open_max_f32.x, result_min.x, result_max.x)
                            && covers(open_min_f32.y, open_max_f32.y, result_min.y, result_max.y)
                            && covers(open_min_f32.z, open_max_f32.z, result_min.z, result_max.z)
                    };
                    if aabb_engulfs && opening_engulfs_host_solid(&result, opening_mesh) {
                        // Mark the host consumed so the element pipeline keeps
                        // the empty result instead of falling back to the un-cut
                        // host.
                        self.record_void_consumed_host(element_id);
                        result = Mesh::default();
                        host_mutated = true;
                        break;
                    }

                    let tri_before = result.triangle_count();
                    let failures_before = clipper.failure_count();
                    let mut csg_succeeded = false;
                    // Tracks whether CSG returned the host *unchanged* (the kernel
                    // either found no real intersection, or errored on a grazing/
                    // coplanar cutter and returned the un-cut host).
                    let mut csg_unchanged = false;
                    // PENETRATING CUTTER (PART A): push the opening's caps a hair
                    // PAST the host along its depth axis so a flush cap becomes a
                    // clean transversal crossing — the exact kernel then cuts the
                    // tilted, faceted roof opening with no bridging sliver (#1007
                    // host #1112). Falls back to the raw opening mesh when no depth
                    // direction is known (the kernel handles a true through-cutter
                    // anyway; the extension only matters for the flush-cap case).
                    let depth_dir = extrusion_dir
                        .filter(|d| d.norm() > NORMALIZE_EPSILON)
                        .unwrap_or_else(|| opening_mesh_thinnest_axis_dir(opening_mesh));
                    let extended_opening = Self::extend_opening_mesh_through_host(
                        opening_mesh,
                        &result,
                        depth_dir,
                    );
                    let cutter = &extended_opening;
                    if let Ok(csg_result) = clipper.subtract_mesh(&result, cutter) {
                        let min_tris = (tri_before / CSG_TRIANGLE_RETENTION_DIVISOR)
                            .max(MIN_VALID_TRIANGLES);
                        // CSG only counts as a success when the result actually
                        // changed (either fewer triangles, indicating polygons
                        // were removed, or more triangles, indicating the
                        // opening was carved as new boundary tris). When the
                        // safety thresholds in `subtract_mesh` short-circuit,
                        // e.g. `MAX_CSG_POLYGONS_PER_MESH` rejects a high-poly
                        // round/curved opening (issue #635), the host mesh is
                        // returned unchanged, leaving the void uncut.
                        let changed = csg_result.triangle_count() != tri_before;
                        csg_unchanged = !changed;
                        if !csg_result.is_empty()
                            && csg_result.triangle_count() >= min_tris
                            && changed
                        {
                            result = csg_result;
                            host_mutated = true;
                            csg_succeeded = true;
                        }
                    }

                    // AABB fallback (issue #635): when CSG can't subtract the
                    // opening (most commonly because its triangulated profile
                    // exceeds `MAX_CSG_POLYGONS_PER_MESH`, i.e. circular /
                    // arched / arbitrary curved openings), cut the opening's
                    // axis-aligned bounding box instead. This leaves a square
                    // hole in place of a round one, but a square hole is
                    // dramatically less wrong than a missing void on a wall
                    // that is supposed to host a window or door.
                    if !csg_succeeded {
                        let dir = extrusion_dir.or_else(|| {
                            Some(wall_thinnest_axis_dir(&wall_min, &wall_max))
                        });
                        let (final_min, final_max) = if let Some(dir) = dir {
                            self.extend_opening_along_direction(
                                *open_min_pt,
                                *open_max_pt,
                                wall_min,
                                wall_max,
                                dir,
                            )
                        } else {
                            (*open_min_pt, *open_max_pt)
                        };
                        // Near-engulf guard. When CSG returned the host *unchanged*
                        // (no cut) AND the opening's AABB covers the whole wall on
                        // every axis, the rectangular fallback would cut that
                        // engulfing box and delete the wall. This is the signature
                        // of a non-rectangular opening whose bounding box engulfs
                        // the host while its real profile excludes it: the kernel
                        // errors on the grazing/coplanar cutter and returns the
                        // un-cut host, which is already the correct result vs
                        // IfcOpenShell (advanced #555433's facade-scale void
                        // #555493). Keep the un-cut host instead of over-cutting.
                        // Normal windows/doors — including the issue-635 high-poly
                        // round openings the AABB box approximates — sit INSIDE the
                        // wall and never engulf it, so they still take the fallback.
                        // The 3% per-axis tolerance absorbs an opening that reaches
                        // ~flush with a wall face (its near plane).
                        let engulfs_host = {
                            let tol = 0.03_f64;
                            let covers = |omin: f64, omax: f64, wmin: f64, wmax: f64| {
                                let slack = (wmax - wmin).abs().max(1.0e-9) * tol;
                                omin <= wmin + slack && omax >= wmax - slack
                            };
                            covers(final_min.x, final_max.x, wall_min.x, wall_max.x)
                                && covers(final_min.y, final_max.y, wall_min.y, wall_max.y)
                                && covers(final_min.z, final_max.z, wall_min.z, wall_max.z)
                        };
                        // Only suppress the fallback when "unchanged" means the
                        // kernel found no real cut (a kernel error / no-overlap on
                        // a grazing engulfing cutter). `capped` keys on the
                        // historical `OperandTooLarge` rejection (issue #635 /
                        // #947): the exact kernel has no operand cap so it is
                        // now always false, but keeping the term costs
                        // nothing and stays correct if a complexity budget ever
                        // records it again.
                        let capped = clipper.has_operand_too_large_since(failures_before);
                        // Issue #964: suppress the destructive AABB box when the
                        // host already has this void cut into it (a void
                        // double-encoded as both a profile inner curve and a
                        // redundant IfcOpeningElement). When every column through
                        // the opening footprint is already open in the host,
                        // cutting the bounding box would replace a correct
                        // round/polygonal hole with a rectangle. Unlike the
                        // engulf heuristic this is a positive void detection, so
                        // it overrides `capped` too (the void demonstrably
                        // exists — there is nothing left to approximate).
                        let probe_axis = dir.unwrap_or_else(|| {
                            wall_thinnest_axis_dir(&wall_min, &wall_max)
                        });
                        let redundant_void =
                            opening_redundant_with_host(&result, opening_mesh, &probe_axis);
                        let suppress_fallback =
                            redundant_void || (csg_unchanged && engulfs_host && !capped);
                        if !suppress_fallback {
                            // Diagnostic for issue #635: log the opening
                            // triangle count when the AABB fallback actually
                            // fires, so round windows (post profile
                            // simplification) can be confirmed to hit CSG and
                            // only genuinely-uncut voids land on the box cut.
                            #[cfg(any(debug_assertions, test))]
                            {
                                eprintln!(
                                    "[issue-635] AABB fallback used: opening={} tris (CSG produced no change)",
                                    opening_mesh.triangle_count()
                                );
                            }
                            // Deliberate degraded mode: this fallback removes
                            // the wall material inside the opening AABB but no
                            // longer emits reveal/recess quads (deleted with
                            // the legacy clip path), so its output has an open
                            // rim. Acceptable for a safety net that fired 0x
                            // across the regression corpus — the exact-kernel
                            // path ahead of it emits the reveals itself.
                            let aabb_cut =
                                self.cut_rectangular_opening(&result, final_min, final_max);
                            if !aabb_cut.is_empty() && aabb_cut.triangle_count() != tri_before {
                                result = aabb_cut;
                                host_mutated = true;
                            }
                        }
                    }
                }
            }
        }

        // NOTE (issue #635): the clipping planes from `IfcBooleanClippingResult`
        // are already applied by `BooleanClippingProcessor::process` during
        // `process_element` — the post-clip mesh is the *input* to this
        // function. Re-clipping here was a leftover from before that
        // processor existed; for `IfcPolygonalBoundedHalfSpace` it actively
        // *broke* gable walls, because `extract_half_space_plane` discards
        // the polygonal bound and the resulting unbounded plane chops off
        // the gable peak. Voids alone are applied here.

        // Drain whatever fallbacks the kernel logged during this element's
        // void / clip pass, attribute them to the host product, and stash on
        // the router so the caller can surface them (e.g. flagged in a
        // viewer overlay or asserted in regression tests).
        let kernel_failures = clipper.take_failures();
        if !kernel_failures.is_empty() {
            self.record_host_failure_summary(element_id, &kernel_failures);
            self.record_csg_failures(element_id, kernel_failures);
        }

        // WATERTIGHT SLIVER REFINEMENT (issue #1007): the exact-kernel cut of a
        // long, tilted faceted-BREP host facet can emit a high-aspect corner
        // sliver (a far-corner triangle fanned to two new rim vertices a few cm
        // apart) that lands ALONE in its plane bucket and so bypasses the
        // coplanar CDT. Bisect any >8:1 triangle's longest edge at its midpoint,
        // splitting BOTH incident triangles in lockstep so the mesh stays
        // watertight (no T-junction) and the midpoint lies ON the original edge
        // ⇒ cut volume is preserved exactly. A no-op on clean cuts (no triangle
        // exceeds 8:1), so it does not perturb the frozen corpus. Only runs when
        // a cut was actually attempted (`!ctx.is_noop()` guarantees this path).
        let mut result = crate::facet_weld::refine_high_aspect_slivers(&result);

        // UNDER-CUT REPAIR: a self-intersecting tessellated cutter (garbage
        // vertices metres from the real opening) makes the kernel UNDER-cut — a
        // wall flap bridges the opening. Re-cut each such opening with a clean
        // box (removes only the opening prism, taking the flap, while preserving
        // and re-triangulating the wall around the hole). Done HERE, in the cut
        // frame (host + cutters share it), and BEFORE the spike clip so any
        // residual protrusion is still caught. A no-op when no cutter is
        // malformed — clean openings are never reshaped.
        recut_malformed_openings(&mut result, &ctx.malformed_opening_boxes());

        // SPURIOUS-FLAP CLIP: a subtract can only remove material, so the cut is
        // mathematically contained in the host's pre-cut AABB (`wall_min/max`).
        // A malformed cutter (self-intersecting, or with garbage vertices metres
        // from the real opening — the multi-body / tessellated-void case) can
        // make the exact arrangement leak a far-flung flap triangle that pokes
        // out of the wall, but only once a SECOND cutter perturbs the
        // arrangement (so it slips past the per-cutter admission guards). Drop
        // any triangle with a vertex beyond the host AABB; `pad` absorbs kernel
        // snap / f64→f32 round-trip jitter (legit cut vertices land sub-mm
        // inside). A no-op on clean cuts.
        let diag = ((wall_max.x - wall_min.x).powi(2)
            + (wall_max.y - wall_min.y).powi(2)
            + (wall_max.z - wall_min.z).powi(2))
        .sqrt();
        let pad = (1.0e-3 * diag).max(5.0e-3) as f32;
        result.clip_triangles_to_aabb(
            [wall_min.x as f32, wall_min.y as f32, wall_min.z as f32],
            [wall_max.x as f32, wall_max.y as f32, wall_max.z as f32],
            pad,
        );

        // Per-host cut-effect snapshot: tris_before / tris_after lets the
        // diagnostic surface the silent-no-op case (rectangular boxes
        // processed but the host mesh came out unchanged — the box
        // probably didn't intersect the wall, e.g. wrong placement).
        self.record_host_cut_effect(
            element_id,
            tris_before,
            result.triangle_count(),
            synth_rect.len(),
            host_bounds_capture,
        );

        result
    }

    /// Process an element into per-item sub-meshes with opening subtraction.
    ///
    /// Mirrors [`process_element_with_voids`] but preserves each
    /// `IfcShapeRepresentation` item as its own sub-mesh so that callers can
    /// look up a direct `IfcStyledItem` color per geometry item (e.g. the
    /// three extrusion layers of a multi-layer wall). The opening(s) are
    /// subtracted from each sub-mesh independently so that windows and doors
    /// cut through every material layer they intersect.
    ///
    /// Returns an empty collection when there are no openings (callers should
    /// fall back to [`process_element_with_submeshes`]) or when every
    /// sub-mesh is destroyed by void subtraction.
    pub fn process_element_with_submeshes_and_voids(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        void_index: &FxHashMap<u32, Vec<u32>>,
    ) -> Result<SubMeshCollection> {
        // Layered single-solid path: slice the element's base mesh by its
        // material-layer buildup AFTER subtracting voids. This produces one
        // sub-mesh per layer keyed by IfcMaterial id, so layers show up as
        // individual colors even when the underlying geometry is a single
        // swept solid.
        if let Some(layered) = self.try_layered_sub_meshes(element, decoder, Some(void_index)) {
            return Ok(layered);
        }

        let opening_ids = match void_index.get(&element.id) {
            Some(ids) if !ids.is_empty() => ids.clone(),
            _ => return Ok(SubMeshCollection::new()),
        };

        let sub_meshes = self.process_element_with_submeshes(element, decoder)?;
        if sub_meshes.is_empty() {
            return Ok(SubMeshCollection::new());
        }

        // Classify openings + resolve clipping planes ONCE per element. Doing
        // this per sub-mesh would re-run `process_element` on every opening
        // and re-extract clipping planes N times, multiplying the expensive
        // parsing/CSG setup by the sub-mesh count on the exact elements this
        // path targets (multi-layer walls with windows).
        let ctx = self.build_void_context(element, &opening_ids, decoder);

        let mut voided = SubMeshCollection::new();
        for sub in sub_meshes.sub_meshes {
            let geometry_id = sub.geometry_id;
            let mut voided_mesh = self.apply_void_context(sub.mesh, &ctx, element.id);
            // Same CSG-seam hygiene as the single-mesh void path.
            voided_mesh.clean_degenerate();
            if !voided_mesh.is_empty() {
                voided
                    .sub_meshes
                    .push(SubMesh::new(geometry_id, voided_mesh));
            }
        }

        Ok(voided)
    }
}

#[cfg(test)]
mod flap_clip_tests {
    use super::*;

    fn box_cutter_mesh(half: [f64; 3], garbage: &[[f64; 3]]) -> Mesh {
        // 8 corners of an axis-aligned box centred at origin + far garbage verts.
        let mut m = Mesh::new();
        for sx in [-1.0, 1.0] {
            for sy in [-1.0, 1.0] {
                for sz in [-1.0, 1.0] {
                    m.positions.extend_from_slice(&[
                        (sx * half[0]) as f32,
                        (sy * half[1]) as f32,
                        (sz * half[2]) as f32,
                    ]);
                }
            }
        }
        for g in garbage {
            m.positions
                .extend_from_slice(&[g[0] as f32, g[1] as f32, g[2] as f32]);
        }
        m
    }

    /// A cutter with far garbage "fins" is detected as malformed and its real
    /// opening box is recovered (the fins are excluded).
    #[test]
    fn opening_obb_detects_malformed_and_recovers_box() {
        let cutter = box_cutter_mesh([1.0, 0.1, 1.2], &[[0.0, 9.0, 0.0], [0.0, -9.0, 0.0]]);
        let b = opening_obb_if_malformed(&cutter).expect("malformed cutter -> box");
        let mut half = b.half;
        half.sort_by(|a, c| a.partial_cmp(c).unwrap());
        assert!((half[0] - 0.1).abs() < 0.05, "thin half {:?}", b.half);
        assert!((half[1] - 1.0).abs() < 0.05, "mid half {:?}", b.half);
        assert!((half[2] - 1.2).abs() < 0.05, "long half {:?}", b.half);
    }

    /// A well-formed cutter (no far cluster) is NOT reshaped.
    #[test]
    fn opening_obb_skips_wellformed_cutter() {
        let cutter = box_cutter_mesh([1.0, 0.1, 1.2], &[]);
        assert!(opening_obb_if_malformed(&cutter).is_none());
    }

    fn signed_volume(m: &Mesh) -> f64 {
        let v = |i: u32| {
            let b = i as usize * 3;
            [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
        };
        m.indices
            .chunks_exact(3)
            .map(|t| {
                let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
                (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                    + a[2] * (b[0] * c[1] - b[1] * c[0]))
                    / 6.0
            })
            .sum::<f64>()
            .abs()
    }

    /// An axis-aligned box mesh (helper) via the canonical corner order.
    fn aabb_box(half: [f64; 3]) -> Mesh {
        let axes = [Vector3::x(), Vector3::y(), Vector3::z()];
        let bx = OpeningBox { center: Vector3::zeros(), axes, half };
        bx.extended_box_mesh([0.0; 3], 0.0)
    }

    /// `recut_malformed_openings` carves a clean through-opening AND preserves
    /// the wall AROUND it — the regression where a plain triangle-drop also
    /// removed the legitimate wall above/below the opening.
    #[test]
    fn recut_carves_opening_and_preserves_wall_around_it() {
        // Solid wall box: 4 (x) x 0.3 (y) x 3 (z) centred at origin.
        let mut host = aabb_box([2.0, 0.15, 1.5]);
        let host_vol = signed_volume(&host);
        // A 1 x 1 window through it (thin axis y; recut extends it through).
        let bx = OpeningBox {
            center: Vector3::zeros(),
            axes: [Vector3::x(), Vector3::y(), Vector3::z()],
            half: [0.5, 0.079, 0.5],
        };
        recut_malformed_openings(&mut host, std::slice::from_ref(&bx));
        assert!(!host.is_empty(), "recut emptied the wall");
        // Wall extent preserved on every face axis (no over-cut of the wall
        // above/below/beside the opening).
        let (lo, hi) = host.bounds();
        assert!((hi.z - 1.5).abs() < 0.02, "wall top removed (z max {})", hi.z);
        assert!((lo.z + 1.5).abs() < 0.02, "wall bottom removed (z min {})", lo.z);
        assert!((hi.x - 2.0).abs() < 0.02, "wall side removed (x max {})", hi.x);
        // The opening prism (~1 x 0.3 x 1 = 0.3 m^3) was actually carved out.
        let cut_vol = signed_volume(&host);
        assert!(
            cut_vol < host_vol - 0.2,
            "opening not carved (host {host_vol:.3}, cut {cut_vol:.3})"
        );
    }
}
