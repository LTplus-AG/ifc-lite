// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Malformed-cutter (#1007) repair: detect a self-intersecting void cutter's
//! real oriented box and re-cut with a clean one, plus the cutter-frame
//! translation helper. Split out of `mod.rs` to keep it under the
//! module-size ratchet.

use crate::csg::ClippingProcessor;
use crate::{Mesh, Point3, Vector3};
use nalgebra::Matrix3;
use rustc_hash::FxHashMap;

/// An oriented box: world centre, orthonormal axes, half-extents along each.
pub(super) struct OpeningBox {
    pub(super) center: Vector3<f64>,
    pub(super) axes: [Vector3<f64>; 3],
    pub(super) half: [f64; 3],
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
    pub(super) fn extended_box_mesh(&self, origin: [f64; 3], extend: f64) -> Mesh {
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

/// True if `m` welds (by position) to a CLOSED 2-manifold: every edge is shared
/// by exactly two triangles — the topological signature of a valid solid. A
/// clean opening box AND a watertight roof/gable prism (a tall cutter reaching
/// hundreds of metres up to clip a wall to the roofline) both pass; only a
/// self-intersecting / fin-laden GARBAGE cutter (the #1007 family) leaves
/// boundary or non-manifold edges and fails. Conservative: a cutter with too
/// few faces to bound a solid (e.g. a stray point cloud) is NOT closed, so it
/// stays eligible for the malformed-cutter repair.
pub(super) fn cutter_is_closed_manifold(m: &Mesh) -> bool {
    // A closed solid needs >= 4 triangles (a tetrahedron).
    if m.indices.len() < 12 {
        return false;
    }
    // Weld duplicated per-face vertices back together so shared edges are
    // detectable; 10 µm is far below any real opening feature.
    let w = m.welded_by_position(1.0e-5);
    if w.indices.len() < 12 {
        return false;
    }
    let mut edge_uses: FxHashMap<(u32, u32), u32> = FxHashMap::default();
    for t in w.indices.chunks_exact(3) {
        if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
            return false; // a degenerate triangle survived welding
        }
        for &(a, b) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let key = if a < b { (a, b) } else { (b, a) };
            *edge_uses.entry(key).or_insert(0) += 1;
        }
    }
    edge_uses.values().all(|&c| c == 2)
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
pub(super) fn opening_obb_if_malformed(m: &Mesh) -> Option<OpeningBox> {
    // A cutter that welds to a closed solid is well-formed by construction — its
    // far vertices are STRUCTURAL (a watertight roof prism, not stray garbage),
    // so the far-cluster heuristic below must never reshape it. This is what
    // separates a legitimate gable/roof cut (whose top can sit ~900 m up) from
    // the self-intersecting tessellated voids the repair targets.
    if cutter_is_closed_manifold(m) {
        return None;
    }
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
    // Bail on any non-finite vertex so the partial_cmp sorts below cannot panic;
    // a garbage cutter is not worth reshaping (file filters non-finite elsewhere).
    if all.iter().any(|v| v.iter().any(|c| !c.is_finite())) {
        return None;
    }
    let median_axis = |axis: usize| -> f64 {
        let mut vals: Vec<f64> = all.iter().map(|v| v[axis]).collect();
        vals.sort_by(f64::total_cmp);
        vals[vals.len() / 2]
    };
    let med = Vector3::new(median_axis(0), median_axis(1), median_axis(2));
    let mut dist: Vec<(f64, usize)> = all
        .iter()
        .enumerate()
        .map(|(i, v)| ((v - med).norm(), i))
        .collect();
    dist.sort_by(|a, b| a.0.total_cmp(&b.0));
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
        if dist[i + 1].0 > FAR_M && dist[i + 1].0 > 3.0 * near_radius.max(1.0e-3) && gap > dist[i].0
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
    let a0 = eig
        .eigenvectors
        .column(0)
        .into_owned()
        .try_normalize(1.0e-9)?;
    let a1 = eig
        .eigenvectors
        .column(1)
        .into_owned()
        .try_normalize(1.0e-9)?;
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
pub(super) fn recut_malformed_openings(result: &mut Mesh, boxes: &[OpeningBox]) {
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
/// World-space AABB of a host mesh: its local `bounds()` with `mesh.origin`
/// folded back in (world = origin + position). Folded in f64 so a
/// georeferenced host (large origin) keeps as much precision as the f32
/// diagnostic surface allows, rather than reporting near-zero local coords.
pub(super) fn world_host_bounds(mesh: &Mesh) -> ((f32, f32, f32), (f32, f32, f32)) {
    let o = mesh.origin;
    let (mn, mx) = mesh.bounds();
    (
        (
            (mn.x as f64 + o[0]) as f32,
            (mn.y as f64 + o[1]) as f32,
            (mn.z as f64 + o[2]) as f32,
        ),
        (
            (mx.x as f64 + o[0]) as f32,
            (mx.y as f64 + o[1]) as f32,
            (mx.z as f64 + o[2]) as f32,
        ),
    )
}

pub(super) fn translate_cutter_mesh(mesh: &Mesh, host_origin: [f64; 3]) -> Mesh {
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
        local_bounds: None,
        local_to_world: None,
        welded_in_object_frame: false,
    }
}
