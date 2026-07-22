// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::mesh::Mesh;
use nalgebra::{Point3, Vector3};
use rustc_hash::FxHashMap;
use super::ClippingProcessor;

/// Is `v` a degenerate NEEDLE — its shortest edge a hairline relative to its
/// longest? Such a triangle is a zero-area-intended sliver: the exact kernel
/// faithfully spans two near-coincident-but-distinct rim Vids (an f32-import /
/// shallow-dihedral near-duplicate the interner correctly does NOT weld) out to a
/// far vertex (issue #1007 / schependomlaan: the diagonal flap over an opening).
///
/// The test is `min_edge < floor_pow2(max_edge) · 2⁻¹³` — POWER-OF-TWO and
/// scale-relative, so it is bit-deterministic AND catches the needle (min 6.6 µm
/// vs max ~5 m ⇒ threshold ~5·10⁻⁴) while never touching a real thin sliver
/// (e.g. a 0.2 m × 2 m face, min 0.2 m ≫ 2·10⁻⁴). Dropping a needle cannot open a
/// real gap — the hole/seam is already framed by the neighbouring non-degenerate
/// triangles, exactly as Manifold (which welds the near-duplicate) produces.
pub(crate) fn tri_is_needle(v: &[Point3<f64>; 3]) -> bool {
    let d = |a: &Point3<f64>, b: &Point3<f64>| (a - b).norm();
    let (e0, e1, e2) = (d(&v[0], &v[1]), d(&v[1], &v[2]), d(&v[2], &v[0]));
    let mn = e0.min(e1).min(e2);
    let mx = e0.max(e1).max(e2);
    if !mx.is_finite() || mx <= 0.0 {
        return true; // fully degenerate
    }
    mn < floor_pow2(mx) * 2.0_f64.powi(-13)
}

/// Push a single triangle (with the supplied face normal applied to all
/// three vertices) onto `mesh`, UNLESS it is a degenerate needle ([`tri_is_needle`]).
/// Used by `consolidate_coplanar` for plane buckets that don't go through the
/// 2D-union round-trip (single-triangle buckets and the union-collapse fallback);
/// the needle drop here is what removes the #1007 diagonal sliver, since each
/// tilted opening face lands in its own single-triangle plane bucket and would
/// otherwise pass the raw kernel needle through verbatim.
fn emit_triangle(mesh: &mut Mesh, v: &[Point3<f64>; 3], normal: &Vector3<f64>) {
    if tri_is_needle(v) {
        return;
    }
    let base = mesh.vertex_count() as u32;
    mesh.add_vertex(v[0], *normal);
    mesh.add_vertex(v[1], *normal);
    mesh.add_vertex(v[2], *normal);
    mesh.add_triangle(base, base + 1, base + 2);
}

/// Count OPEN boundary edges: undirected edges whose directed half-edges do not
/// pair (one forward + one reverse). Vertices are merged on a 1 mm grid — bigger
/// than the few-ULP spread between the per-bucket duplicate vertices
/// `consolidate_coplanar` emits at a shared position (a finer grid would read every
/// inter-bucket edge as "open"), yet far smaller than a genuine crack (which spans a
/// facet width, cm). A watertight closed mesh returns 0; the consolidation tear
/// shows up as a positive count the (watertight) raw kernel output lacks.
fn count_open_boundary_edges(mesh: &Mesh) -> usize {
    if mesh.positions.len() < 9 || mesh.indices.len() < 3 {
        return 0;
    }
    let q = |v: f32| (v as f64 * 1.0e3).round() as i64;
    let mut vid: FxHashMap<(i64, i64, i64), u32> = FxHashMap::default();
    let mut id_of = |i: usize| -> u32 {
        let k = (
            q(mesh.positions[i * 3]),
            q(mesh.positions[i * 3 + 1]),
            q(mesh.positions[i * 3 + 2]),
        );
        let next = vid.len() as u32;
        *vid.entry(k).or_insert(next)
    };
    let mut bal: FxHashMap<(u32, u32), i32> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (
            id_of(tri[0] as usize),
            id_of(tri[1] as usize),
            id_of(tri[2] as usize),
        );
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let (key, s) = if x < y { ((x, y), 1) } else { ((y, x), -1) };
            *bal.entry(key).or_insert(0) += s;
        }
    }
    bal.values().filter(|&&v| v != 0).count()
}

/// Count spike triangles (longest-edge / shortest-edge > 50:1) — the same quality
/// bar the `csg_quality_regression` tests use. Combined with the open-edge count
/// into a "badness" score so the consolidation fallback reverts to raw ONLY when raw
/// is the cleaner mesh overall (a curved / offset-jittered host's raw is watertight
/// AND well-formed), never when raw carries needle fans consolidation would merge.
fn count_spike_triangles(mesh: &Mesh) -> usize {
    let mut n = 0usize;
    for tri in mesh.indices.chunks_exact(3) {
        let p = |i: u32| {
            let i = i as usize;
            [
                mesh.positions[i * 3],
                mesh.positions[i * 3 + 1],
                mesh.positions[i * 3 + 2],
            ]
        };
        let (a, b, c) = (p(tri[0]), p(tri[1]), p(tri[2]));
        let d = |u: [f32; 3], v: [f32; 3]| {
            ((u[0] - v[0]).powi(2) + (u[1] - v[1]).powi(2) + (u[2] - v[2]).powi(2)).sqrt()
        };
        let (e0, e1, e2) = (d(a, b), d(b, c), d(c, a));
        let mn = e0.min(e1).min(e2);
        let mx = e0.max(e1).max(e2);
        if mn > 1.0e-6 && mx / mn > 50.0 {
            n += 1;
        }
    }
    n
}

/// Drop 2D contour vertices that are collinear with both neighbours. The
/// i_overlay union of many small fragments often leaves "phantom"
/// vertices on every fragment boundary that crosses the outer outline;
/// without this pass earcut would emit one sliver triangle per phantom.
fn simplify_2d_collinear(ring: &[nalgebra::Point2<f64>]) -> Vec<nalgebra::Point2<f64>> {
    let n = ring.len();
    if n < 4 {
        return ring.to_vec();
    }
    let mut keep = vec![true; n];
    let mut changed = true;
    while changed {
        changed = false;
        for i in 0..n {
            if !keep[i] {
                continue;
            }
            let prev = (1..n).map(|k| (i + n - k) % n).find(|&k| keep[k]);
            let next = (1..n).map(|k| (i + k) % n).find(|&k| keep[k]);
            let (prev, next) = match (prev, next) {
                (Some(p), Some(n)) if p != i && n != i && p != n => (p, n),
                _ => continue,
            };
            let a = ring[prev];
            let b = ring[i];
            let c = ring[next];
            let e1x = b.x - a.x;
            let e1y = b.y - a.y;
            let e2x = c.x - b.x;
            let e2y = c.y - b.y;
            let cross = e1x * e2y - e1y * e2x;
            let len1 = (e1x * e1x + e1y * e1y).sqrt();
            let len2 = (e2x * e2x + e2y * e2y).sqrt();
            let denom = len1 * len2;
            // 1e-4 = sin(0.006°). Real arc samples sit well above this
            // (cavity 6-seg per quadrant ⇒ 15°/segment ⇒ sin ≈ 0.26); the
            // i_overlay union of split fragments leaves "phantom" vertices
            // whose sin(angle) ranges 1e-7..1e-5, all caught here.
            if denom < 1.0e-18 || (cross.abs() / denom) < 1.0e-4 {
                keep[i] = false;
                changed = true;
            }
        }
    }
    ring.iter()
        .zip(keep.iter())
        .filter_map(|(p, k)| if *k { Some(*p) } else { None })
        .collect()
}

/// Largest power of two ≤ `x` (x finite, > 0). The exponent is read straight
/// off the IEEE-754 bits, so the result is an EXACT f64 with a single set bit —
/// bit-identical across x86_64/aarch64/wasm (no rounding, no transcendental).
#[inline]
fn floor_pow2(x: f64) -> f64 {
    if !x.is_finite() || x <= 0.0 {
        return 0.0;
    }
    // 2^floor(log2(x)) via the unbiased exponent of the f64 representation.
    let exp = x.to_bits() >> 52 & 0x7ff; // biased exponent
    let unbiased = exp as i64 - 1023;
    // f64::powi keeps a power-of-two base exact; 2.0_f64.powi is exact for the
    // representable exponent range we hit (|coords| ≲ 1e7 ⇒ exponent ≲ 24).
    2.0_f64.powi(unbiased as i32)
}

/// Merge consecutive near-coincident 2D contour vertices BEFORE the union/earcut.
///
/// The exact mesh-arrangement kernel correctly preserves two distinct rim points
/// that the modeller intended as one but f32 import / a shallow-dihedral LPI
/// crossing split a few µm apart (issue #1007 / schependomlaan: the diagonal
/// sliver "flap" over an opening). They reach `consolidate_coplanar` as a hairline
/// notch on the hole/outer ring; `simplify_2d_collinear` (a TURN-ANGLE test) does
/// not remove them, so earcut frames the notch out to a far vertex → a degenerate
/// needle (aspect ≫ 10⁵) that renders as a flap across the opening.
///
/// This collapses any vertex within `eps` of its kept predecessor onto that
/// predecessor. `eps` is a POWER OF TWO scaled to the ring's bounding-box extent
/// (`floor_pow2(extent) · 2⁻¹³` ≈ extent/8192) and CAPPED at an absolute
/// 2⁻¹² m (244 µm) — bit-deterministic. On the #1007 fixture the rim
/// duplicates span 6–72 µm on ~2 m faces (~3·10⁻⁶ … 4·10⁻⁵ of the extent)
/// while the smallest REAL feature edge is 0.2 m (~0.1 of the extent), so eps
/// (~10⁻⁴ of the extent) sits three orders of magnitude above the duplicate
/// spread and three below any real edge — no over-weld. The absolute cap is
/// what protects mm-scale features on LARGE rings: the duplicate spread comes
/// from f32 import noise / shallow-dihedral LPI crossings whose magnitude does
/// NOT grow with ring extent (operands are snapped about their AABB centre),
/// but an uncapped extent-relative eps reaches 1 mm at 8 m and would swallow a
/// genuine 1 mm chamfer on a long steel member. This runs in the already-
/// non-exact consolidation post-pass; it does NOT touch the exact kernel's
/// interner/predicates (no float weld in the determinism path).
fn weld_near_coincident_2d(ring: &[nalgebra::Point2<f64>]) -> Vec<nalgebra::Point2<f64>> {
    let n = ring.len();
    if n < 4 {
        return ring.to_vec();
    }
    let (mut minx, mut miny, mut maxx, mut maxy) =
        (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in ring {
        minx = minx.min(p.x);
        miny = miny.min(p.y);
        maxx = maxx.max(p.x);
        maxy = maxy.max(p.y);
    }
    let extent = (maxx - minx).max(maxy - miny);
    if !extent.is_finite() || extent <= 0.0 {
        return ring.to_vec();
    }
    // extent · 2⁻¹³ rounded DOWN to a power of two, capped at an absolute
    // 2⁻¹² m so big rings can't swallow mm-scale features ⇒ exact, deterministic.
    let eps = (floor_pow2(extent) * 2.0_f64.powi(-13)).min(2.0_f64.powi(-12));
    let eps2 = eps * eps;
    let mut kept: Vec<nalgebra::Point2<f64>> = Vec::with_capacity(n);
    for &p in ring {
        let dup = kept.last().is_some_and(|q| {
            let dx = p.x - q.x;
            let dy = p.y - q.y;
            dx * dx + dy * dy < eps2
        });
        if !dup {
            kept.push(p);
        }
    }
    // close-the-loop check: last vs first.
    if kept.len() >= 2 {
        let (first, last) = (kept[0], *kept.last().unwrap());
        let dx = last.x - first.x;
        let dy = last.y - first.y;
        if dx * dx + dy * dy < eps2 {
            kept.pop();
        }
    }
    if kept.len() >= 3 {
        kept
    } else {
        ring.to_vec()
    }
}

impl ClippingProcessor {
    /// Re-merge the kernel's per-plane fragments via 2D polygon union, then
    /// earcut each result back to triangles. CSG over-fragments host faces
    /// along operand cut lines; a naive edge-walk merge fails on the
    /// "X" crossings that appear at cutter-outline corners (four fragments
    /// sharing only a vertex), so we project each plane bucket to 2D, run
    /// the same `i_overlay` boolean engine `bool2d.rs` already uses elsewhere
    /// in the crate, and earcut the resulting (possibly annular) shapes.
    /// This is what brought the bath from 189 → ~50
    /// triangles with the cavity outline intact (issue #780); it also hosts
    /// the needle/weld cleanup passes for #1007.
    ///
    /// Returns the input mesh unchanged if the consolidate fails or yields
    /// nothing — never worse than the raw kernel output.
    pub(crate) fn consolidate_coplanar(mesh: Mesh) -> Mesh {
        use crate::grid::NORMAL_QUANT_F64 as NORMAL_QUANT;
        use crate::triangulation::{
            project_to_2d_with_basis, triangulate_polygon_with_holes_refined,
        };
        use i_overlay::core::fill_rule::FillRule;
        use i_overlay::core::overlay_rule::OverlayRule;
        use i_overlay::float::single::SingleFloatOverlay;

        if mesh.indices.len() < 6 {
            return mesh;
        }

        // Quantization for plane bucketing — normals are coarser (1e3) than
        // positions because cross-product noise on near-coplanar tris can
        // wobble in the 6th decimal; offsets get the same coarsening so
        // bucket keys stay aligned with normal direction.
        //
        // NB (issue #1007): the offset key is deliberately FINE (1 µm) and must
        // NOT be coarsened. The exact-kernel opening cut on a faceted-BREP roof
        // emits the hole-boundary triangles on planes that jitter ~25–150 µm;
        // that jitter is what keeps each on its own bucket. Coalescing them (a
        // coarser offset grid, or projecting the whole roof slope to ONE canonical
        // plane) lets the i_overlay UNION close the opening hole — a bridging facet
        // over the footprint, caught by `issue_1007_real_opening_no_bridge`.
        const POS_QUANT: f64 = 1.0e6;
        let qpos = |p: f64| (p * POS_QUANT).round() as i64;
        let qnorm = |n: f64| (n * NORMAL_QUANT).round() as i64;

        // Step 1 — group input triangles by plane.
        struct PlaneTri {
            v: [Point3<f64>; 3],
            normal: Vector3<f64>,
        }
        let positions = &mesh.positions;
        let vertex_count = positions.len() / 3;
        // BTreeMap, NOT FxHashMap: step 2 emits the output mesh in bucket
        // iteration order, and FxHasher mixes usize-wide chunks, so its
        // iteration order differs between 64-bit native and 32-bit wasm32 -
        // the same cut came out with a different (valid but non-identical)
        // triangle order per target, breaking the native==wasm mesh-output
        // determinism manifest. Ord-keyed iteration is target-independent
        // (same pattern as facet_weld's normal_buckets); bucket counts per
        // cut are small, so the tree overhead is noise.
        let mut buckets: std::collections::BTreeMap<(i64, i64, i64, i64), Vec<PlaneTri>> =
            std::collections::BTreeMap::new();
        for chunk in mesh.indices.chunks_exact(3) {
            let (i0, i1, i2) = (chunk[0] as usize, chunk[1] as usize, chunk[2] as usize);
            if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
                continue;
            }
            let v0 = Point3::new(
                positions[i0 * 3] as f64,
                positions[i0 * 3 + 1] as f64,
                positions[i0 * 3 + 2] as f64,
            );
            let v1 = Point3::new(
                positions[i1 * 3] as f64,
                positions[i1 * 3 + 1] as f64,
                positions[i1 * 3 + 2] as f64,
            );
            let v2 = Point3::new(
                positions[i2 * 3] as f64,
                positions[i2 * 3 + 1] as f64,
                positions[i2 * 3 + 2] as f64,
            );
            let edge1 = v1 - v0;
            let edge2 = v2 - v0;
            let cross = edge1.cross(&edge2);
            let len = cross.norm();
            if len < 1.0e-10 {
                continue;
            }
            let normal = cross / len;
            let offset = normal.dot(&v0.coords);
            let key = (
                qnorm(normal.x),
                qnorm(normal.y),
                qnorm(normal.z),
                qpos(offset),
            );
            buckets.entry(key).or_default().push(PlaneTri {
                v: [v0, v1, v2],
                normal,
            });
        }

        let mut output = Mesh::new();

        // Step 2 — per bucket, union triangles in 2D, triangulate result.
        for tris in buckets.values() {
            if tris.is_empty() {
                continue;
            }
            // Use the FIRST triangle's normal/anchor for a stable 2D basis;
            // all tris in this bucket share the plane by construction.
            let normal = tris[0].normal;
            let origin = tris[0].v[0];
            let abs = (normal.x.abs(), normal.y.abs(), normal.z.abs());
            let reference = if abs.0 <= abs.1 && abs.0 <= abs.2 {
                Vector3::new(1.0, 0.0, 0.0)
            } else if abs.1 <= abs.2 {
                Vector3::new(0.0, 1.0, 0.0)
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            };
            let u_axis = normal.cross(&reference).normalize();
            let v_axis = normal.cross(&u_axis).normalize();
            // CCW-in-2D convention: i_overlay's NonZero fill needs each
            // input triangle wound CCW in (u, v). Our 3D triangles are CCW
            // looking down `normal`; the (u, v) basis above is right-handed
            // with `v = normal × u`, so projection preserves winding.

            // Project each triangle to 2D and build i_overlay paths.
            if tris.len() == 1 {
                // Single triangle — skip the union round-trip entirely.
                emit_triangle(&mut output, &tris[0].v, &normal);
                continue;
            }
            let mut subject: Vec<Vec<[f64; 2]>> = Vec::with_capacity(1);
            let mut clip: Vec<Vec<[f64; 2]>> = Vec::with_capacity(tris.len() - 1);
            for (idx, tri) in tris.iter().enumerate() {
                let pts_2d = project_to_2d_with_basis(&tri.v, &u_axis, &v_axis, &origin);
                // Force CCW for i_overlay's NonZero fill — kernel output
                // fragments can carry inconsistent winding, and mixed-winding
                // subject + clip cancel out instead of unioning.
                let signed_area = (pts_2d[1].x - pts_2d[0].x)
                    * (pts_2d[2].y - pts_2d[0].y)
                    - (pts_2d[2].x - pts_2d[0].x)
                        * (pts_2d[1].y - pts_2d[0].y);
                let path: Vec<[f64; 2]> = if signed_area >= 0.0 {
                    pts_2d.iter().map(|p| [p.x, p.y]).collect()
                } else {
                    pts_2d.iter().rev().map(|p| [p.x, p.y]).collect()
                };
                if idx == 0 {
                    subject.push(path);
                } else {
                    clip.push(path);
                }
            }

            let shapes = subject.overlay(&clip, OverlayRule::Union, FillRule::NonZero);
            if shapes.is_empty() {
                // Union collapsed everything — emit originals to avoid loss.
                for t in tris {
                    emit_triangle(&mut output, &t.v, &normal);
                }
                continue;
            }

            // Total bucket area — used to filter sub-resolution shapes /
            // holes (f64 noise leaves tiny spurious cavities after the
            // i_overlay union).
            let bucket_area: f64 = tris
                .iter()
                .map(|t| {
                    let pts =
                        project_to_2d_with_basis(&t.v, &u_axis, &v_axis, &origin);
                    0.5_f64
                        * ((pts[1].x - pts[0].x) * (pts[2].y - pts[0].y)
                            - (pts[2].x - pts[0].x) * (pts[1].y - pts[0].y))
                            .abs()
                })
                .sum();
            let min_significant = (bucket_area * 1.0e-4).max(1.0e-8);

            let signed_area_2d = |ring: &[nalgebra::Point2<f64>]| -> f64 {
                let n = ring.len();
                if n < 3 {
                    return 0.0;
                }
                let mut s = 0.0;
                for i in 0..n {
                    let j = (i + 1) % n;
                    s += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
                }
                s * 0.5
            };

            for shape in shapes {
                if shape.is_empty() {
                    continue;
                }
                let outer_2d: Vec<nalgebra::Point2<f64>> = shape[0]
                    .iter()
                    .map(|p| nalgebra::Point2::new(p[0], p[1]))
                    .collect();
                // Weld µm-scale near-coincident rim duplicates FIRST (the #1007
                // diagonal-sliver source), THEN drop collinear phantoms.
                let outer_welded = weld_near_coincident_2d(&outer_2d);
                let outer_simplified = simplify_2d_collinear(&outer_welded);
                if outer_simplified.len() < 3 {
                    continue;
                }
                let outer_area = signed_area_2d(&outer_simplified).abs();
                if outer_area < min_significant {
                    continue;
                }
                let holes_simplified: Vec<Vec<nalgebra::Point2<f64>>> = shape
                    .iter()
                    .skip(1)
                    .filter_map(|c| {
                        let pts: Vec<_> = c
                            .iter()
                            .map(|p| nalgebra::Point2::new(p[0], p[1]))
                            .collect();
                        let welded = weld_near_coincident_2d(&pts);
                        let simplified = simplify_2d_collinear(&welded);
                        if simplified.len() < 3 {
                            return None;
                        }
                        let area = signed_area_2d(&simplified).abs();
                        if area < min_significant {
                            return None;
                        }
                        Some(simplified)
                    })
                    .collect();

                // Quality CDT + bounded Ruppert refinement. Returns the
                // (possibly Steiner-augmented) 2D vertex list `all_2d` plus
                // indices into it; the lift below maps EVERY returned vertex
                // (input + Steiner) back to 3D, so a Steiner point on a shared
                // edge is split on both sides → watertight, no T-junction.
                // Refinement is interior-only: this region's outer/hole rings
                // are shared with neighbouring plane buckets triangulated
                // independently; a boundary Steiner point would tear that seam
                // (open edges / T-junctions). Interior-only refinement keeps the
                // seam watertight while still removing the rim-corner slivers.
                let (all_2d, indices) = match triangulate_polygon_with_holes_refined(
                    &outer_simplified,
                    &holes_simplified,
                ) {
                    Ok((pts, idx)) => (pts, idx),
                    Err(_) => continue,
                };

                let lift = |p: nalgebra::Point2<f64>| -> Point3<f64> {
                    let off = u_axis * p.x + v_axis * p.y;
                    origin + off
                };
                let mut verts_3d: Vec<Point3<f64>> = Vec::with_capacity(all_2d.len());
                for p in &all_2d {
                    verts_3d.push(lift(*p));
                }

                let base = output.vertex_count() as u32;
                for vp in &verts_3d {
                    output.add_vertex(*vp, normal);
                }
                for tri in indices.chunks_exact(3) {
                    // Needle backstop: drop any residual sub-weld degenerate sliver
                    // ([`tri_is_needle`], the same scale-relative power-of-two rule
                    // as the single-triangle path). Cannot open a real gap — the
                    // hole/seam is framed by its non-degenerate neighbours.
                    let v = [
                        verts_3d[tri[0]],
                        verts_3d[tri[1]],
                        verts_3d[tri[2]],
                    ];
                    if tri_is_needle(&v) {
                        continue;
                    }
                    output.add_triangle(
                        base + tri[0] as u32,
                        base + tri[1] as u32,
                        base + tri[2] as u32,
                    );
                }
            }
        }

        if output.is_empty() {
            return mesh;
        }
        // WATERTIGHTNESS GUARD (curved / opening-dense wall hairline cracks). The
        // per-bucket re-triangulation above treats each coplanar plane bucket
        // independently. Where a FLAT bucket's boundary runs along a faceted surface
        // — an opening reveal, a cap, the rim of a curved or offset-jittered wall —
        // the i_overlay union + collinear simplify chords that boundary, dropping the
        // facet-boundary vertices the abutting buckets keep. The result is open
        // boundary edges + T-junctions at the cut seam that the raw kernel output
        // (which is watertight) did NOT have = the white horizontal hairlines that
        // shimmer under DoubleSide. Detect it directly and pick the better mesh by
        // (open edges + spike triangles): when consolidation introduced open edges
        // and the raw mesh is the cleaner one overall, return raw. A curved/offset-
        // jittered host's raw is watertight and well-formed (raw wins -> crack gone);
        // a host whose raw carries needle fans consolidation exists to merge keeps the
        // consolidated mesh. Watertight, spike-free hosts (the overwhelming majority,
        // incl. #780 bath and ordinary flat walls) have cons_open == 0 and return
        // immediately -> byte-identical, determinism snapshots unmoved. The exact
        // kernel (and `indirect_sign_manifest`) is untouched; this only repairs what
        // the post-kernel consolidation drops.
        // Cheap geometric pre-filter so the per-host open-edge scan (its hashmap is
        // the WASM load cost, not the rare fallback) stays OFF the hot path for the
        // ~13k ordinary box-like walls. A host can only have a chorded seam if it is
        // FACETED: either NON-ORTHOGONAL plane pairs (a curved wall, a sloped gable
        // roof clip — neither parallel nor perpendicular) or many PARALLEL offset
        // buckets per normal direction (an f32-jittered opening-dense wall like the
        // curved reception counter, distinct_normals=5 / 168 planes). A box wall has
        // only axis-aligned planes and consolidates watertight -> skipped.
        let mut bnorms: Vec<Vector3<f64>> = Vec::new();
        for tris in buckets.values() {
            if let Some(t0) = tris.first() {
                if !bnorms.iter().any(|m| m.dot(&t0.normal).abs() > 0.99999) {
                    bnorms.push(t0.normal);
                }
            }
        }
        let nonorthogonal = (0..bnorms.len()).any(|i| {
            ((i + 1)..bnorms.len()).any(|j| {
                let d = bnorms[i].dot(&bnorms[j]).abs();
                d > 0.01 && d < 0.9999 // angle in (~0.8°, ~89.4°)
            })
        });
        let offset_jittered = buckets.len() > 4 * bnorms.len().max(1);
        if nonorthogonal || offset_jittered {
            let cons_open = count_open_boundary_edges(&output);
            if cons_open > 0 {
                let raw_bad = count_open_boundary_edges(&mesh) + count_spike_triangles(&mesh);
                let cons_bad = cons_open + count_spike_triangles(&output);
                if raw_bad < cons_bad {
                    return mesh;
                }
            }
        }
        // Carry the input's placement / frame metadata (`origin` local-frame
        // translation, `rtc_applied`, and the #1474 world-capture `local_bounds` /
        // `local_to_world`) onto the re-triangulated output. `consolidate_coplanar`
        // only re-triangulates coplanar faces — the geometry stays in the SAME
        // frame — but `output` is a bare `Mesh::new()` whose defaults reset those
        // fields to zero/None. For a LOCAL-FRAME caller (origin != 0: the prism /
        // coaxial-union void fast paths, #1806/#1815) that reset drops the host's
        // per-element origin and mis-places the whole cut host at the world origin
        // (the mesh.rs #1474 hazard; mirrors `refine_high_aspect_slivers`'s
        // `rebuilt_like`). World-frame callers (origin 0) are unaffected. The early
        // `return mesh` branches above already carry the original frame.
        output.rtc_applied = mesh.rtc_applied;
        output.origin = mesh.origin;
        output.local_bounds = mesh.local_bounds;
        output.local_to_world = mesh.local_to_world;
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_pow2_is_exact_and_deterministic() {
        // Exact powers map to themselves; in-between rounds DOWN to the prev power.
        assert_eq!(floor_pow2(1.0), 1.0);
        assert_eq!(floor_pow2(2.0), 2.0);
        assert_eq!(floor_pow2(8.0), 8.0);
        assert_eq!(floor_pow2(1.9), 1.0);
        assert_eq!(floor_pow2(5.657), 4.0);
        assert_eq!(floor_pow2(0.2), 0.125);
        assert_eq!(floor_pow2(0.0), 0.0);
        assert_eq!(floor_pow2(-3.0), 0.0);
        // every result has exactly one set mantissa bit ⇒ bit-deterministic
        for x in [0.3_f64, 1.7, 3.0, 17.9, 1024.0, 1e-3, 1e6] {
            let p = floor_pow2(x);
            assert!(p > 0.0 && p <= x);
            assert_eq!(p.to_bits() & 0x000f_ffff_ffff_ffff, 0, "floor_pow2({x}) not a clean power of two");
        }
    }

    #[test]
    fn tri_is_needle_flags_hairline_slivers_not_real_thin_faces() {
        // The #1007 needle: 6.6 µm base, ~5 m apex span → drop.
        let needle = [
            Point3::new(4.672253608703613, -1.0, 12.385885238647461),
            Point3::new(1.047027587890625, -5.0, 14.07635498046875),
            Point3::new(4.672259330749512, -1.0, 12.385882377624512),
        ];
        assert!(tri_is_needle(&needle), "the #1007 diagonal sliver was not flagged");
        // A REAL thin sliver (0.2 m × 2 m face) must be KEPT.
        let real_thin = [
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(2.0, 0.0, 0.0),
            Point3::new(2.0, 0.2, 0.0),
        ];
        assert!(!tri_is_needle(&real_thin), "a real 0.2×2 m sliver was wrongly flagged");
        // A healthy near-equilateral triangle is kept.
        let healthy = [
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(0.5, 0.9, 0.0),
        ];
        assert!(!tri_is_needle(&healthy));
        // A fully-collapsed triangle (zero longest edge) is degenerate → drop.
        let collapsed = [Point3::new(1.0, 1.0, 1.0); 3];
        assert!(tri_is_needle(&collapsed));
    }

    #[test]
    fn weld_near_coincident_2d_collapses_um_rim_duplicates() {
        use nalgebra::Point2;
        // A unit-ish quad whose 4th corner is split into a 6.6 µm near-duplicate
        // (the rim-notch shape that earcut would otherwise frame as a needle).
        let ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(1.9, 0.0),
            Point2::new(1.9, 1.0),
            Point2::new(0.000_006_6, 1.0),
            Point2::new(0.0, 1.0),
        ];
        let welded = weld_near_coincident_2d(&ring);
        assert_eq!(welded.len(), 4, "near-coincident rim duplicate not welded: {welded:?}");
        // A ring with only genuine (≥0.2 m) edges is untouched.
        let clean = vec![
            Point2::new(0.0, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 0.2),
            Point2::new(0.0, 0.2),
        ];
        assert_eq!(weld_near_coincident_2d(&clean).len(), 4, "a clean ring was over-welded");
    }

    #[test]
    fn weld_near_coincident_2d_keeps_mm_features_on_large_rings() {
        use nalgebra::Point2;
        // A 12 m × 1 m member face with a 1 mm corner chamfer (two vertices
        // 1 mm apart). Uncapped extent-relative eps (12/8192 ≈ 1.46 mm) would
        // weld the chamfer away; the absolute 2⁻¹² m cap must keep it.
        let chamfered = vec![
            Point2::new(0.0, 0.0),
            Point2::new(12.0, 0.0),
            Point2::new(12.0, 0.999),
            Point2::new(11.999, 1.0), // 1 mm chamfer edge
            Point2::new(0.0, 1.0),
        ];
        let welded = weld_near_coincident_2d(&chamfered);
        assert_eq!(
            welded.len(),
            5,
            "1 mm chamfer on a 12 m ring was over-welded: {welded:?}"
        );
        // µm-scale rim duplicates must still weld on the SAME large ring.
        let ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(12.0, 0.0),
            Point2::new(12.0, 1.0),
            Point2::new(0.000_02, 1.0), // 20 µm duplicate of the corner
            Point2::new(0.0, 1.0),
        ];
        assert_eq!(
            weld_near_coincident_2d(&ring).len(),
            4,
            "µm rim duplicate on a large ring not welded"
        );
    }

    #[test]
    fn merge_coplanar_collapses_subdivided_quad() {
        // Quad on z=0 plane split into 4 triangles via a centroid vertex.
        // consolidate_coplanar should reassemble it into a single quad and
        // triangulate that into 2 triangles.
        let mut mesh = Mesh::new();
        for p in [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 0.0],
        ] {
            mesh.add_vertex(
                Point3::new(p[0], p[1], p[2]),
                Vector3::new(0.0, 0.0, 1.0),
            );
        }
        mesh.add_triangle(0, 1, 4);
        mesh.add_triangle(1, 2, 4);
        mesh.add_triangle(2, 3, 4);
        mesh.add_triangle(3, 0, 4);

        let consolidated = ClippingProcessor::consolidate_coplanar(mesh);
        assert_eq!(
            consolidated.indices.len() / 3,
            2,
            "consolidated quad should triangulate to 2 tris, got {}",
            consolidated.indices.len() / 3
        );
    }

    #[test]
    fn consolidate_preserves_local_frame_origin() {
        // Regression (#1806 void fast-path misplacement): `consolidate_coplanar`
        // rebuilds into a bare `Mesh::new()` whose `origin`/`rtc_applied`/#1474
        // capture default to zero. A LOCAL-FRAME host (origin != 0 — the wasm
        // default, and the frame the prism/coaxial void fast paths cut in) must
        // keep its per-element `origin` through the merge, or the whole cut host
        // is re-placed at the world origin (the AC20-FZK-Haus ground-floor walls
        // that floated ~6 m off the building). Uses the same subdivided quad the
        // merge test drives so consolidation genuinely runs (not the early
        // `return mesh` no-op path, which trivially preserves the frame).
        let mut mesh = Mesh::new();
        for p in [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 0.0],
        ] {
            mesh.add_vertex(Point3::new(p[0], p[1], p[2]), Vector3::new(0.0, 0.0, 1.0));
        }
        mesh.add_triangle(0, 1, 4);
        mesh.add_triangle(1, 2, 4);
        mesh.add_triangle(2, 3, 4);
        mesh.add_triangle(3, 0, 4);
        mesh.origin = [11.85, 5.0, 1.35];
        mesh.rtc_applied = true;

        let consolidated = ClippingProcessor::consolidate_coplanar(mesh);
        // Sanity: consolidation actually ran (merged 4 tris -> 2), i.e. the
        // `output` path (not an early `return mesh`) produced this result.
        assert_eq!(
            consolidated.indices.len() / 3,
            2,
            "test precondition: the mesh must consolidate so the rebuilt-output frame carry is exercised"
        );
        assert_eq!(
            consolidated.origin,
            [11.85, 5.0, 1.35],
            "consolidate_coplanar dropped the local-frame origin — the cut host would render at the world origin"
        );
        assert!(
            consolidated.rtc_applied,
            "consolidate_coplanar dropped rtc_applied"
        );
    }

    #[test]
    fn merge_coplanar_collapses_edge_split_quad() {
        // Quad whose boundary edge from (0,0) → (2,0) is split into three
        // segments by inserted collinear vertices (0.5, 0, 0) and
        // (1.5, 0, 0). Simulates a CSG kernel's "cutter crossed the host
        // edge here" fragment output. Must collapse back to 2 triangles.
        let mut mesh = Mesh::new();
        for p in [
            [0.0, 0.0, 0.0],
            [0.5, 0.0, 0.0],
            [1.5, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
        ] {
            mesh.add_vertex(
                Point3::new(p[0], p[1], p[2]),
                Vector3::new(0.0, 0.0, 1.0),
            );
        }
        // Fan from corner 0 keeps everything CCW.
        mesh.add_triangle(0, 1, 5);
        mesh.add_triangle(1, 2, 5);
        mesh.add_triangle(2, 4, 5);
        mesh.add_triangle(2, 3, 4);

        let consolidated = ClippingProcessor::consolidate_coplanar(mesh);
        assert_eq!(
            consolidated.indices.len() / 3,
            2,
            "edge-split quad must collapse to 2 tris after collinear cleanup, got {}",
            consolidated.indices.len() / 3
        );
    }

    /// Build a watertight curved (arc-extruded) wall solid with `n` facets over a
    /// quarter turn, radius `r`, thickness `t`, height `h`. Each facet is its own
    /// plane bucket in `consolidate_coplanar` — the curved-wall seam case.
    fn curved_wall(n: usize, r: f64, t: f64, h: f64) -> Mesh {
        use std::f64::consts::PI;
        let mut m = Mesh::with_capacity(0, 0);
        let nrm = Vector3::new(0.0, 0.0, 0.0);
        let mut verts = Vec::new();
        for i in 0..=n {
            let a = (i as f64) / (n as f64) * (PI / 2.0);
            let (c, s) = (a.cos(), a.sin());
            verts.push(Point3::new(r * c, r * s, 0.0)); // 4i+0 O_bot
            verts.push(Point3::new(r * c, r * s, h)); //   4i+1 O_top
            verts.push(Point3::new((r - t) * c, (r - t) * s, 0.0)); // 4i+2 I_bot
            verts.push(Point3::new((r - t) * c, (r - t) * s, h)); //   4i+3 I_top
        }
        for p in &verts {
            m.add_vertex(*p, nrm);
        }
        let (ob, ot, ib, it) = (
            |i: usize| 4 * i as u32,
            |i: usize| 4 * i as u32 + 1,
            |i: usize| 4 * i as u32 + 2,
            |i: usize| 4 * i as u32 + 3,
        );
        let quad = |a: u32, b: u32, c: u32, d: u32, m: &mut Mesh| {
            m.add_triangle(a, b, c);
            m.add_triangle(a, c, d);
        };
        for i in 0..n {
            quad(ob(i), ob(i + 1), ot(i + 1), ot(i), &mut m); // outer
            quad(ib(i + 1), ib(i), it(i), it(i + 1), &mut m); // inner
            quad(ot(i), ot(i + 1), it(i + 1), it(i), &mut m); // top
            quad(ib(i), ib(i + 1), ob(i + 1), ob(i), &mut m); // bottom
        }
        quad(ob(0), ot(0), it(0), ib(0), &mut m); // cap @ a=0
        quad(ib(n), it(n), ot(n), ob(n), &mut m); // cap @ a=90
        m
    }

    fn axis_box(lo: [f64; 3], hi: [f64; 3]) -> Mesh {
        let mut m = Mesh::with_capacity(8, 36);
        let n = Vector3::new(0.0, 0.0, 0.0);
        let c = [
            Point3::new(lo[0], lo[1], lo[2]),
            Point3::new(hi[0], lo[1], lo[2]),
            Point3::new(hi[0], hi[1], lo[2]),
            Point3::new(lo[0], hi[1], lo[2]),
            Point3::new(lo[0], lo[1], hi[2]),
            Point3::new(hi[0], lo[1], hi[2]),
            Point3::new(hi[0], hi[1], hi[2]),
            Point3::new(lo[0], hi[1], hi[2]),
        ];
        for p in c.iter() {
            m.add_vertex(*p, n);
        }
        for tri in [
            [0u32, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
            [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6],
            [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7],
        ] {
            m.add_triangle(tri[0], tri[1], tri[2]);
        }
        m
    }

    /// Count open boundary edges (undirected edges whose directed half-edges do
    /// not pair forward+reverse) on a micron-snapped vertex topology — a watertight
    /// closed mesh has 0.
    fn count_open_edges(mesh: &Mesh) -> usize {
        use std::collections::HashMap;
        let q = |v: f32| (v as f64 * 1.0e6).round() as i64;
        let mut vid: HashMap<(i64, i64, i64), u32> = HashMap::new();
        let mut id = |i: usize| -> u32 {
            let k = (
                q(mesh.positions[i * 3]),
                q(mesh.positions[i * 3 + 1]),
                q(mesh.positions[i * 3 + 2]),
            );
            let n = vid.len() as u32;
            *vid.entry(k).or_insert(n)
        };
        let mut edge: HashMap<(u32, u32), i32> = HashMap::new();
        for tri in mesh.indices.chunks_exact(3) {
            let (a, b, c) = (id(tri[0] as usize), id(tri[1] as usize), id(tri[2] as usize));
            for (x, y) in [(a, b), (b, c), (c, a)] {
                let (k, s) = if x < y { ((x, y), 1) } else { ((y, x), -1) };
                *edge.entry(k).or_insert(0) += s;
            }
        }
        edge.values().filter(|&&v| v != 0).count()
    }

    #[test]
    fn curved_wall_opening_seam_is_watertight() {
        let host = curved_wall(8, 5.0, 0.3, 3.0); // 11.25°/facet
        assert_eq!(count_open_edges(&host), 0, "host must be watertight");
        // a window box straddling the arc around 30°..60°
        let cutter = axis_box([2.4, 2.4, 1.0], [4.4, 4.4, 2.0]);
        let raw = crate::kernel::mesh_bridge::subtract(&host, &cutter);
        let raw_open = count_open_edges(&raw);
        let consolidated = ClippingProcessor::consolidate_coplanar(raw.clone());
        let cons_open = count_open_edges(&consolidated);
        eprintln!(
            "SEAMTEST raw_tris={} raw_open={} cons_tris={} cons_open={}",
            raw.triangle_count(),
            raw_open,
            consolidated.triangle_count(),
            cons_open
        );
        assert_eq!(raw_open, 0, "raw kernel output must be watertight");
        assert_eq!(
            cons_open, 0,
            "consolidate must preserve the curved-wall opening seam (was torn)"
        );
    }
}
