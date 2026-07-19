// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Coaxial footprint-union for OVERLAPPING opening clusters (issue #129 lever).
//!
//! The disjoint-cutter batching ([`super`]) collapses openings whose extended
//! AABBs are pairwise disjoint into ONE conforming `subtract_mesh_many`
//! arrangement. Openings whose cutters OVERLAP cannot join a batch — a shared
//! interior boundary makes the N-ary subtract diverge from the true union — so
//! today they fall to the per-opening SEQUENTIAL exact path: N arrangements of a
//! growing host, the dominant cost on i129's opening-dense slabs (one slab with
//! 47 openings, others 39/34/29/24; the cutter prisms overlap).
//!
//! Those overlapping clusters are almost always COAXIAL: every cutter penetrates
//! along one shared axis (35 of 37 multi-opening i129 hosts). For such a cluster
//! the removed solid is `union(footprint_i) × depth`. This module recovers it
//! CHEAPLY and EXACTLY:
//!   1. CLUSTER cutters by extended-AABB overlap (union-find, the SAME 1 mm pad
//!      the batching uses so touching-but-not-overlapping cutters stay disjoint).
//!   2. For a COAXIAL cluster whose members share ONE depth band along the axis,
//!      project every cutter's cap footprint to the plane ⟂ the axis, UNION them
//!      in ONE i_overlay pass (`union_contours_to_shapes`, NonZero fill — not
//!      pairwise), then re-extrude each union shape (outer + holes, via the
//!      watertight CDT caps) back along the axis over the shared band. The result
//!      is a set of PAIRWISE-DISJOINT prisms fed to the existing
//!      `subtract_mesh_many` — N sequential arrangements become ONE.
//!   3. A non-coaxial, or mixed-depth-band, overlapping cluster routes to the
//!      overlap-safe 3D `union_many` (union-then-subtract).
//!
//! CORRECTNESS (never emit worse than the exact kernel):
//!   * 2.5D: only cutters whose depth intervals along the axis COINCIDE (within
//!     tolerance) are footprint-unioned — a partial-depth / blind cutter is never
//!     stretched to a through-cut. Mixed bands defer to `union_many`.
//!   * TRUE cross-section: the footprint is the union of the cutter's CAP
//!     triangles (normal ∥ axis), not the AABB rectangle, so a non-rectangular
//!     opening is cut faithfully. A union shape may carry HOLES (a window grid
//!     leaving a mullion) → multiple disjoint prisms, all fed.
//!   * Every re-extruded prism is checked watertight; the batched subtract must
//!     succeed AND change the host. On ANY failure the whole cluster is left
//!     untouched for the sequential exact path (its members stay unconsumed).
//!
//! Gate: `IFC_LITE_VOID_UNION=0` disables the whole pass (A/B; feature-off is
//! byte-identical to the pre-#129 sequential behaviour). Default ON. wasm has no
//! env, so the default holds on both targets. All math is f64 (FMA-free,
//! `total_cmp` ordering) before the f32 store → deterministic native==wasm.

use nalgebra::{Matrix4, Point2, Vector3};

use super::geom::{mesh_is_closed_exact, mesh_signed_volume, opening_mesh_thinnest_axis_dir};
use super::sweep::cut_changed_mesh;
use super::{OpeningType, NORMALIZE_EPSILON};
use crate::bool2d::union_contours_to_shapes;
use crate::csg::ClippingProcessor;
use crate::extrusion::{apply_transform, extrude_profile_watertight};
use crate::mesh::Mesh;
use crate::router::GeometryRouter;

#[cfg(test)]
thread_local! {
    /// Per-test override of [`enabled`], so a test can exercise BOTH the feature-on
    /// and feature-off paths deterministically without racing the process-global
    /// `OnceLock`/env default (parallel tests each get their own thread-local).
    static ENABLED_OVERRIDE: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// Test-only: force [`enabled`] on (`Some(true)`) / off (`Some(false)`) for the
/// current thread, or clear the override (`None`).
#[cfg(test)]
pub(super) fn set_enabled_override(v: Option<bool>) {
    ENABLED_OVERRIDE.with(|c| c.set(v));
}

/// `IFC_LITE_VOID_UNION=0` disables the coaxial/overlap union pass (every
/// overlapping cluster falls to the sequential exact path). Default ON; read once.
pub(super) fn enabled() -> bool {
    #[cfg(test)]
    {
        if let Some(v) = ENABLED_OVERRIDE.with(|c| c.get()) {
            return v;
        }
    }
    use std::sync::OnceLock;
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("IFC_LITE_VOID_UNION").as_deref() != Ok("0"))
}

/// An admitted overlapping-cluster candidate cutter.
struct UnionCand {
    /// Index into the caller's `all_openings` slice (for consumption marking).
    idx: usize,
    /// The raw (un-extended) opening cutter mesh.
    mesh: Mesh,
    /// Unit penetration axis (authored extrusion dir, or the mesh's thinnest axis).
    dir: Vector3<f64>,
    /// Extended-AABB (through-host + 1 mm pad) for the overlap graph.
    lo: [f64; 3],
    hi: [f64; 3],
}

/// A cutter's cap footprint (in the shared frame's ⟂ plane) plus its depth span
/// along the axis. Only cutters that pass `cutter_footprint`'s prism reconciliation
/// (`area × depth ≈ |mesh volume|`) are represented here.
struct Footprint {
    contours: Vec<Vec<Point2<f64>>>,
    z_lo: f64,
    z_hi: f64,
}

impl GeometryRouter {
    /// Cut every OVERLAPPING opening cluster in `all_openings` from `result` via
    /// the coaxial footprint-union (or the 3D `union_many` fallback), marking the
    /// consumed openings in `consumed` and setting `host_mutated` on any real cut.
    ///
    /// A cluster whose members are all pairwise disjoint (a size-1 overlap
    /// component) is left for the disjoint batching / sequential path — this pass
    /// only touches genuinely OVERLAPPING clusters. Any cluster that fails a guard
    /// or self-check is left fully unconsumed for the sequential exact path, so
    /// the emitted mesh is never worse than exact.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn coaxial_union_prepass(
        &self,
        result: &mut Mesh,
        all_openings: &[&OpeningType],
        consumed: &mut [bool],
        host_mutated: &mut bool,
        clipper: &ClippingProcessor,
    ) {
        if !enabled() || all_openings.len() < 2 {
            return;
        }
        // 1 mm pad — identical to the disjoint batching's BATCH_PAD, so a cutter
        // pair that the batching would treat as disjoint (touching, not
        // overlapping) is ALSO disjoint here and never merged into a cluster.
        const PAD: f64 = 1.0e-3;

        // Admit candidates with the same light guards the sequential loop applies
        // (valid mesh, overlaps the host, above the volume floor). The footprint /
        // watertight validation happens per cluster below.
        let (hmn, hmx) = result.bounds();
        let min_vol = Self::min_opening_volume(self.tessellation_quality);
        let mut cands: Vec<UnionCand> = Vec::new();
        for (idx, opening) in all_openings.iter().enumerate() {
            if consumed[idx] {
                continue;
            }
            let (mesh, dir_hint): (&Mesh, Option<Vector3<f64>>) = match **opening {
                OpeningType::Rectangular(..) => continue,
                OpeningType::DiagonalRectangular(ref m, ref f) => (m, Some(f.depth)),
                OpeningType::NonRectangular(ref m, _, _, ref d) => (m, *d),
            };
            let valid = !mesh.is_empty()
                && mesh.positions.iter().all(|&v| v.is_finite())
                && mesh.positions.len() >= 9;
            if !valid {
                continue;
            }
            let (omn, omx) = mesh.bounds();
            let overlaps_host = !(omx.x < hmn.x
                || omn.x > hmx.x
                || omx.y < hmn.y
                || omn.y > hmx.y
                || omx.z < hmn.z
                || omn.z > hmx.z);
            if !overlaps_host {
                continue;
            }
            let open_vol =
                (omx.x - omn.x) as f64 * (omy_span(omn.y, omx.y)) * (omx.z - omn.z) as f64;
            if open_vol < min_vol {
                continue;
            }
            let dir = dir_hint
                .filter(|d| d.norm() > NORMALIZE_EPSILON)
                .map(|d| d.normalize())
                .unwrap_or_else(|| opening_mesh_thinnest_axis_dir(mesh).normalize());
            if !dir.iter().all(|c| c.is_finite()) || dir.norm() < 0.5 {
                continue;
            }
            // Extended-AABB for the overlap graph: pierce the host along `dir`
            // exactly as the cut will, so the cluster reflects the CUT footprints.
            let ext = Self::extend_opening_mesh_through_host(mesh, result, dir);
            let (elo, ehi) = ext.bounds();
            cands.push(UnionCand {
                idx,
                mesh: mesh.clone(),
                dir,
                lo: [elo.x as f64 - PAD, elo.y as f64 - PAD, elo.z as f64 - PAD],
                hi: [ehi.x as f64 + PAD, ehi.y as f64 + PAD, ehi.z as f64 + PAD],
            });
        }
        if cands.len() < 2 {
            return;
        }

        // Union-find over the extended-AABB overlap graph (deterministic in
        // candidate/opening order).
        let mut parent: Vec<usize> = (0..cands.len()).collect();
        fn find(parent: &mut [usize], mut x: usize) -> usize {
            while parent[x] != x {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            x
        }
        for a in 0..cands.len() {
            for b in (a + 1)..cands.len() {
                if aabb_overlap(&cands[a].lo, &cands[a].hi, &cands[b].lo, &cands[b].hi) {
                    let ra = find(&mut parent, a);
                    let rb = find(&mut parent, b);
                    if ra != rb {
                        parent[ra.max(rb)] = ra.min(rb);
                    }
                }
            }
        }
        // Group candidate indices by component root, preserving order.
        let mut components: Vec<(usize, Vec<usize>)> = Vec::new();
        for i in 0..cands.len() {
            let r = find(&mut parent, i);
            match components.iter_mut().find(|(root, _)| *root == r) {
                Some((_, v)) => v.push(i),
                None => components.push((r, vec![i])),
            }
        }

        for (_, members) in &components {
            if members.len() < 2 {
                continue; // disjoint singleton → disjoint batching / sequential
            }
            self.cut_overlapping_cluster(result, &cands, members, consumed, host_mutated, clipper);
        }
    }

    /// Cut one OVERLAPPING cluster (≥ 2 members). Tries the coaxial footprint
    /// union first, then the 3D `union_many` fallback; on any failure leaves every
    /// member unconsumed for the sequential exact path.
    #[allow(clippy::too_many_arguments)]
    fn cut_overlapping_cluster(
        &self,
        result: &mut Mesh,
        cands: &[UnionCand],
        members: &[usize],
        consumed: &mut [bool],
        host_mutated: &mut bool,
        clipper: &ClippingProcessor,
    ) {
        // Coaxial? Every member's axis NEAR-EXACTLY parallel to the reference. The
        // footprint-union path reconstructs each cutter as a prism by projecting its
        // caps ONTO the plane ⟂ `ref_dir`; for a member whose own axis is tilted
        // from `ref_dir` that projection INFLATES the footprint (and stretches the
        // depth band), so the re-extruded prism is NOT geometrically equivalent to
        // the cutter and can OVER-CUT the host. The old 0.985 gate (~10°) was far too
        // loose for treating a projected-cap reconstruction as exact. Require near-
        // exact alignment (matching the #1806 oblique-opening rationale) so only
        // genuinely axis-aligned coaxial openings take the union path; anything more
        // tilted DEFERS to the overlap-safe 3D `union_many` below (which unions the
        // ACTUAL cutter solids — no projection — so it is exact for any tilt).
        const COAXIAL_DOT_MIN: f64 = 1.0 - 1.0e-6;
        let ref_dir = cands[members[0]].dir;
        let coaxial = members
            .iter()
            .all(|&m| cands[m].dir.dot(&ref_dir).abs() >= COAXIAL_DOT_MIN);

        if coaxial {
            if let Some((prisms, multi_slab, contributors, max_removed)) =
                self.build_coaxial_prisms(result, cands, members, &ref_dir)
            {
                if self.subtract_prisms(result, &prisms, multi_slab, max_removed, clipper) {
                    // Consume ONLY cutters that fed an emitted slab prism; one whose
                    // band coalesced below `z_tol` spans no slab (removed nothing) and
                    // stays for the exact path rather than being silently dropped.
                    for &i in &contributors {
                        consumed[cands[members[i]].idx] = true;
                    }
                    *host_mutated = true;
                    return;
                }
            }
        }

        // Fallback: overlap-safe 3D union-then-subtract (a non-coaxial cluster, or
        // a coaxial one whose depth-sliced subtract failed a guard). Extend each
        // cutter through the host, union them in ONE N-ary arrangement, then
        // subtract the single union mesh. On failure the cluster is left unconsumed
        // for the sequential exact path.
        if self.subtract_union3d(result, cands, members, clipper) {
            for &m in members {
                consumed[cands[m].idx] = true;
            }
            *host_mutated = true;
        }
    }

    /// Build the pairwise-disjoint re-extruded prisms for a COAXIAL cluster via
    /// 2.5D depth-slicing along `axis`: the depth axis is cut at every cutter's
    /// authored z-boundary, and within each depth SLAB the footprints of the
    /// cutters that FULLY SPAN it are unioned (one i_overlay pass) and re-extruded
    /// over exactly that slab. A cutter never contributes outside its authored
    /// [z_lo, z_hi], so a partial-depth / blind cutter is cut faithfully — never
    /// stretched to a through-cut. Slabs are Z-disjoint (they share only boundary
    /// planes, which the conforming N-ary subtract dissolves). Returns `None`
    /// (defer to `union_many`) when a footprint can't be recovered, the cluster has
    /// too many distinct depths, or a re-extrude/watertight check fails.
    ///
    /// The third tuple element lists the `members`-relative indices that fed ≥ 1
    /// emitted slab prism; a cutter whose band coalesced below `z_tol` spans no slab
    /// and is absent, so the caller leaves it for the exact path (never dropped).
    ///
    /// The fourth tuple element is an UPPER BOUND on the volume this cut may remove
    /// from the host: Σ over contributing cutters of `footprint_area × depth`. Since
    /// the true removal is `union(cutters) ∩ host ≤ Σ (cutter ∩ host) ≤ Σ area·depth`,
    /// a subtract that removes MORE than this bound (e.g. a `z_tol` depth-band that
    /// bridged distinct bands and over-cut) is REJECTED by `subtract_prisms`, which
    /// then defers the cluster to the exact 3D union.
    fn build_coaxial_prisms(
        &self,
        result: &Mesh,
        cands: &[UnionCand],
        members: &[usize],
        axis: &Vector3<f64>,
    ) -> Option<(Vec<Mesh>, bool, Vec<usize>, f64)> {
        let (u, v, d) = ortho_frame(axis)?;
        let mut fps: Vec<Footprint> = Vec::with_capacity(members.len());
        for &m in members {
            fps.push(cutter_footprint(&cands[m].mesh, &u, &v, &d)?);
        }

        // Total depth span + a tolerance for coalescing near-identical z-boundaries.
        let span_lo = fps.iter().map(|f| f.z_lo).fold(f64::INFINITY, f64::min);
        let span_hi = fps.iter().map(|f| f.z_hi).fold(f64::NEG_INFINITY, f64::max);
        if !span_lo.is_finite() || !span_hi.is_finite() || (span_hi - span_lo) <= NORMALIZE_EPSILON {
            return None;
        }
        let z_tol = (span_hi - span_lo) * 0.01 + 1.0e-3; // 1% of the span + 1 mm

        // Depth breakpoints = every cutter's z_lo / z_hi, sorted and coalesced
        // within z_tol. The intervals between consecutive breakpoints are the slabs.
        let mut breaks: Vec<f64> = fps.iter().flat_map(|f| [f.z_lo, f.z_hi]).collect();
        breaks.sort_by(f64::total_cmp);
        let mut coalesced: Vec<f64> = Vec::with_capacity(breaks.len());
        for b in breaks {
            if coalesced.last().is_none_or(|&p| (b - p).abs() > z_tol) {
                coalesced.push(b);
            }
        }
        // Cap the slab count: a pathological cluster with many distinct depths would
        // fragment into a slab per depth; defer that to `union_many` rather than
        // emitting dozens of stacked prisms.
        if coalesced.len() < 2 || coalesced.len() > 9 {
            return None;
        }

        // Frame → world: local (x, y, z) ↦ x·u + y·v + z·d (orthonormal basis
        // through the origin, so no translation column).
        let m_world = Matrix4::new(
            u.x, v.x, d.x, 0.0, //
            u.y, v.y, d.y, 0.0, //
            u.z, v.z, d.z, 0.0, //
            0.0, 0.0, 0.0, 1.0,
        );

        let mut prisms: Vec<Mesh> = Vec::new();
        // Which members (by fps/`members` position) contributed to ≥ 1 emitted slab.
        let mut contributed = vec![false; fps.len()];
        for w in coalesced.windows(2) {
            let (slab_lo, slab_hi) = (w[0], w[1]);
            let slab_depth = slab_hi - slab_lo;
            if slab_depth <= NORMALIZE_EPSILON {
                continue;
            }
            let mid = 0.5 * (slab_lo + slab_hi);
            // Cutters that FULLY span this slab; record each as a contributor so only
            // cutters this pass actually removed are consumed by the caller.
            let mut contours: Vec<Vec<Point2<f64>>> = Vec::new();
            for (i, f) in fps.iter().enumerate() {
                if f.z_lo <= mid && f.z_hi >= mid {
                    contours.extend(f.contours.iter().cloned());
                    contributed[i] = true;
                }
            }
            if contours.is_empty() {
                continue; // an empty slab (a gap between depth bands) removes nothing
            }
            // ONE i_overlay union of the slab's footprints (overlaps merge exactly).
            let shapes = union_contours_to_shapes(&contours);
            if shapes.is_empty() {
                return None;
            }
            let base = Matrix4::new_translation(&Vector3::new(0.0, 0.0, slab_lo));
            for shape in &shapes {
                if shape.outer.len() < 3 || !crate::bool2d::is_valid_contour(&shape.outer) {
                    return None;
                }
                let mut prism = extrude_profile_watertight(shape, slab_depth, Some(base)).ok()?;
                apply_transform(&mut prism, &m_world);
                // Push caps a hair past any FLUSH host face along the axis so the
                // subtract is a clean transversal crossing. A slab boundary INTERIOR
                // to the host (no host facet there) is left untouched — the two
                // slabs meeting at it tile the void with no gap.
                let ext = Self::extend_opening_mesh_through_host(&prism, result, d);
                if !mesh_is_closed_exact(&ext) {
                    return None;
                }
                prisms.push(ext);
            }
        }
        if prisms.is_empty() {
            return None;
        }
        // `multi_slab` when the depth axis was cut into more than one slab: those
        // prisms share coplanar boundary planes, so the subtract must FUSE them
        // first (see `subtract_prisms`). A single slab yields footprint-disjoint
        // prisms that the N-ary subtract handles directly.
        let multi_slab = coalesced.len() > 2;
        let contributors: Vec<usize> = (0..fps.len()).filter(|&i| contributed[i]).collect();
        // Removed-volume upper bound: Σ over contributing cutters of the volume of the
        // SAME through-host extension the prisms use. The union of the reconstructed
        // prisms equals the union of the actual cutters, so the removed (host-clipped)
        // volume `Vol(∪prism ∩ host) = Vol(∪cutter ∩ host) ≤ Σ Vol(cutter_i ∩ host) ≤
        // Σ Vol(extended cutter_i)` — a subtract that removes MORE (an inflated /
        // bridged prism reconstruction) is over-cutting and is rejected downstream.
        // Using the EXTENDED cutter (not `area × authored_depth`) is essential: a
        // through-cut of a host THICKER than the authored opening legitimately removes
        // more than the authored volume, and must not be mistaken for an over-cut.
        // 2% relative slack absorbs the f32 volume-differencing noise of a large host.
        let max_removed = 1.02
            * contributors
                .iter()
                .map(|&i| {
                    let ext = Self::extend_opening_mesh_through_host(
                        &cands[members[i]].mesh,
                        result,
                        d,
                    );
                    mesh_signed_volume(&ext).abs()
                })
                .sum::<f64>();
        Some((prisms, multi_slab, contributors, max_removed))
    }

    /// Subtract the re-extruded prisms from `result`. Single-slab prisms are
    /// footprint-DISJOINT → ONE conforming N-ary `subtract_mesh_many`, trusted
    /// exactly as the disjoint batching trusts its own. Multi-slab prisms share
    /// coplanar boundary planes, so they are first FUSED with the exact
    /// `union_many` (which dissolves the seams into ONE watertight solid, gated by
    /// `mesh_is_closed_exact`) and subtracted as a single mesh. Returns `true`
    /// (updating `result`) only on a real, non-degenerate change WHOSE removed volume
    /// does not exceed `max_removed` (the over-cut guard); otherwise `false` (the
    /// caller falls back to the 3D union, then defers).
    fn subtract_prisms(
        &self,
        result: &mut Mesh,
        prisms: &[Mesh],
        multi_slab: bool,
        max_removed: f64,
        clipper: &ClippingProcessor,
    ) -> bool {
        let tri_before = result.triangle_count();
        let vol_before = mesh_signed_volume(result);
        if !multi_slab {
            let cutters: Vec<&Mesh> = prisms.iter().collect();
            if let Ok(cut) = clipper.subtract_mesh_many(result, &cutters) {
                return accept_cut(result, cut, tri_before, vol_before, max_removed);
            }
            return false;
        }
        // Multi-slab: fuse the stacked prisms so their shared boundary planes
        // dissolve, then subtract the single closed solid.
        let cutters: Vec<&Mesh> = prisms.iter().collect();
        let union = ClippingProcessor::consolidate_coplanar(
            crate::kernel::mesh_bridge::union_many(&cutters),
        );
        if union.is_empty() || !mesh_is_closed_exact(&union) {
            return false;
        }
        let Ok(cut) = clipper.subtract_mesh(result, &union) else {
            return false;
        };
        accept_cut(result, cut, tri_before, vol_before, max_removed)
    }

    /// 3D overlap-safe fallback: extend every member cutter through the host,
    /// union them with the exact N-ary `union_many`, and subtract the single
    /// watertight union mesh. Returns `true` (and updates `result`) only on a real,
    /// non-degenerate change.
    fn subtract_union3d(
        &self,
        result: &mut Mesh,
        cands: &[UnionCand],
        members: &[usize],
        clipper: &ClippingProcessor,
    ) -> bool {
        let extended: Vec<Mesh> = members
            .iter()
            .map(|&m| Self::extend_opening_mesh_through_host(&cands[m].mesh, result, cands[m].dir))
            .collect();
        let refs: Vec<&Mesh> = extended.iter().collect();
        let union = ClippingProcessor::consolidate_coplanar(crate::kernel::mesh_bridge::union_many(
            &refs,
        ));
        if union.is_empty() || !mesh_is_closed_exact(&union) {
            return false;
        }
        let tri_before = result.triangle_count();
        let vol_before = mesh_signed_volume(result);
        let Ok(cut) = clipper.subtract_mesh(result, &union) else {
            return false;
        };
        // The 3D union of the ACTUAL cutter solids is geometrically exact, so no
        // over-cut bound applies here.
        accept_cut(result, cut, tri_before, vol_before, f64::INFINITY)
    }
}

/// f64 Y-span of two f32 bounds (kept out of the volume expression for clarity).
#[inline]
fn omy_span(lo: f32, hi: f32) -> f64 {
    (hi - lo) as f64
}

/// Accept `cut` as the new `result` iff it is non-empty, retained enough
/// triangles, and genuinely changed the host — the SAME acceptance the disjoint
/// batching applies to its `subtract_mesh_many` output (the watertightness of the
/// cut is guaranteed upstream: each cutter is `mesh_is_closed_exact`, and the
/// kernel's conformity gate rejects a non-conforming arrangement). A blanket
/// `param_cut_watertight` scan here is far too slow on the hot path.
///
/// `max_removed` is an OVER-CUT guard: the cut is rejected if it removed more host
/// volume than the caller's provable upper bound (Σ contributing-cutter footprint
/// volumes for the coaxial prism path; `f64::INFINITY` for the exact 3D union, which
/// cannot over-cut). This catches an approximate union reconstruction — a bridged
/// depth band, a residual projection inflation — before it is committed and consumed
/// as if it were an exact cut, so the cluster instead defers to the exact path.
fn accept_cut(
    result: &mut Mesh,
    cut: Mesh,
    tri_before: usize,
    vol_before: f64,
    max_removed: f64,
) -> bool {
    use super::{CSG_TRIANGLE_RETENTION_DIVISOR, MIN_VALID_TRIANGLES};
    let min_tris = (tri_before / CSG_TRIANGLE_RETENTION_DIVISOR).max(MIN_VALID_TRIANGLES);
    let changed = cut_changed_mesh(&cut, tri_before, vol_before);
    // Removed volume = host solid before − after (both same orientation). A cut that
    // removed MORE than the caller's upper bound is an over-cut → reject (defer).
    let removed = vol_before - mesh_signed_volume(&cut);
    if !cut.is_empty() && cut.triangle_count() >= min_tris && changed && removed <= max_removed {
        *result = cut;
        true
    } else {
        false
    }
}

/// AABB overlap on all three axes (half-open, matching the batching's disjoint
/// test negated).
#[inline]
fn aabb_overlap(alo: &[f64; 3], ahi: &[f64; 3], blo: &[f64; 3], bhi: &[f64; 3]) -> bool {
    !(ahi[0] < blo[0]
        || alo[0] > bhi[0]
        || ahi[1] < blo[1]
        || alo[1] > bhi[1]
        || ahi[2] < blo[2]
        || alo[2] > bhi[2])
}

/// Orthonormal frame `(u, v, d)` with `d` the unit penetration axis. The helper
/// world axis is the one LEAST aligned with `d` (deterministic via `total_cmp`),
/// so `u = normalize(helper × d)` is well-conditioned. `None` for a
/// non-normalisable axis.
fn ortho_frame(axis: &Vector3<f64>) -> Option<(Vector3<f64>, Vector3<f64>, Vector3<f64>)> {
    let d = axis.try_normalize(1e-12)?;
    let ax = [d.x.abs(), d.y.abs(), d.z.abs()];
    // Least-aligned world axis: smallest |component|.
    let mut min_i = 0usize;
    for i in 1..3 {
        if ax[i].total_cmp(&ax[min_i]) == std::cmp::Ordering::Less {
            min_i = i;
        }
    }
    let helper = match min_i {
        0 => Vector3::new(1.0, 0.0, 0.0),
        1 => Vector3::new(0.0, 1.0, 0.0),
        _ => Vector3::new(0.0, 0.0, 1.0),
    };
    let u = helper.cross(&d).try_normalize(1e-12)?;
    let v = d.cross(&u);
    if !u.iter().chain(v.iter()).chain(d.iter()).all(|c| c.is_finite()) {
        return None;
    }
    Some((u, v, d))
}

/// Recover a prism cutter's cross-section footprint in the `(u, v)` plane and its
/// depth span along `d`. The footprint is the union of the cutter's CAP triangles
/// (facet normal ∥ `d`, |n·d| ≥ 0.985), each projected to `(p·u, p·v)` and
/// oriented CCW so opposing caps accumulate rather than cancel.
///
/// Returns `None` (→ defer to the exact 3D union) when the cutter is NOT provably a
/// prism along `d`: no cap facets (oblique cutter), or the recovered cross-section
/// does not reconcile with the cutter's true solid volume
/// (`area × depth ≈ |mesh volume|`). The volume reconciliation rejects tapered,
/// slanted-cap, or otherwise non-extruded cutters whose projected caps would
/// reconstruct a prism that OVER-CUTS the host — the union path must never consume
/// a cutter it cannot reproduce exactly.
fn cutter_footprint(
    mesh: &Mesh,
    u: &Vector3<f64>,
    v: &Vector3<f64>,
    d: &Vector3<f64>,
) -> Option<Footprint> {
    let vc = mesh.positions.len() / 3;
    if vc < 3 {
        return None;
    }
    let vat = |i: u32| -> [f64; 3] {
        let b = i as usize * 3;
        [
            mesh.positions[b] as f64,
            mesh.positions[b + 1] as f64,
            mesh.positions[b + 2] as f64,
        ]
    };
    let mut contours: Vec<Vec<Point2<f64>>> = Vec::new();
    let mut z_lo = f64::INFINITY;
    let mut z_hi = f64::NEG_INFINITY;
    for c in mesh.positions.chunks_exact(3) {
        let s = c[0] as f64 * d.x + c[1] as f64 * d.y + c[2] as f64 * d.z;
        z_lo = z_lo.min(s);
        z_hi = z_hi.max(s);
    }
    if !z_lo.is_finite() || !z_hi.is_finite() || (z_hi - z_lo) <= NORMALIZE_EPSILON {
        return None;
    }
    for t in mesh.indices.chunks_exact(3) {
        if (t[0] as usize) >= vc || (t[1] as usize) >= vc || (t[2] as usize) >= vc {
            continue;
        }
        let (a, b, c) = (vat(t[0]), vat(t[1]), vat(t[2]));
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        let nl = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if nl < 1e-12 {
            continue;
        }
        // Cap facet: normal parallel to the penetration axis.
        let nd = (n[0] * d.x + n[1] * d.y + n[2] * d.z) / nl;
        if nd.abs() < 0.985 {
            continue;
        }
        let proj = |p: [f64; 3]| {
            Point2::new(
                p[0] * u.x + p[1] * u.y + p[2] * u.z,
                p[0] * v.x + p[1] * v.y + p[2] * v.z,
            )
        };
        let tri = [proj(a), proj(b), proj(c)];
        // Orient CCW so both caps (opposite winding) accumulate positive coverage
        // under the NonZero union.
        contours.push(crate::bool2d::ensure_ccw(&tri));
    }
    if contours.is_empty() {
        return None;
    }
    // Cross-section area: each CCW cap triangle contributes positive area; a genuine
    // prism has TWO opposing caps that tile the same footprint, so the sum is 2× the
    // cross-section (holes already subtracted — annular caps tessellate the annulus).
    let cap_area_sum: f64 = contours
        .iter()
        .map(|c| crate::bool2d::compute_signed_area(c).abs())
        .sum();
    let area = 0.5 * cap_area_sum;
    let depth = z_hi - z_lo;
    if area <= NORMALIZE_EPSILON || depth <= NORMALIZE_EPSILON {
        return None;
    }
    // PRISM RECONCILIATION: a true prism along `d` satisfies `area × depth ==
    // |signed volume|`. A tapered/slanted/non-extruded cutter — or one with only one
    // cap facet ⟂ `d` (the other slanted away and dropped) — fails this, so its
    // projected-cap reconstruction is NOT geometrically equivalent and is deferred to
    // the exact 3D union rather than consumed. 5% relative tolerance absorbs f32
    // quantisation / tessellation noise while catching gross non-prisms (a single
    // recovered cap already misses by ~2×).
    let mesh_vol = mesh_signed_volume(mesh).abs();
    let recon_vol = area * depth;
    if (recon_vol - mesh_vol).abs() > 0.05 * recon_vol.max(mesh_vol) {
        return None;
    }
    Some(Footprint {
        contours,
        z_lo,
        z_hi,
    })
}

#[cfg(test)]
#[path = "coaxial_union_tests.rs"]
mod tests;
