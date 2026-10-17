// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Which DIRECTIONS the [`clash_solid`](crate::clash_solid) trust gate measures
//! the intersection's thickness along.
//!
//! Split out of `clash_solid.rs` to keep that module inside the repository's
//! 400-line ceiling; it is one cohesive question — "what could the contact
//! normal of this pair be?" — and the gate itself is the only caller.
//!
//! The short version, in full in [`gate_axes`]: the world axes are always in
//! the set, and every distinct face-normal direction of EACH operand joins
//! them too — box-shaped or not — along with every pairwise cross product
//! between an `a`-face axis and a `b`-face axis. For two boxes that reduces
//! to the classical 15 OBB separating-axis candidates. Because the gate
//! takes the MINIMUM extent over the set, adding an axis can only tighten
//! it.

use crate::math::v3;
use crate::mesh::Mesh;

/// Tolerance for "these three families are mutually perpendicular".
///
/// [`Mesh::positions`] is **f32**, so a face normal reconstructed from a
/// tessellated box's edge vectors carries ~1e-6 rad of round-off, which a
/// 1e-6 dot-product test would reject — and a rejection here silently drops
/// back to the world axes, i.e. back to the very bug this machinery exists to
/// fix. 1e-4 (0.006 rad) admits that round-off while still rejecting a
/// genuinely non-orthogonal frame; the axes are only ever used as *directions
/// to measure an extent along*, where a 0.006 rad error is worth ~2e-5 of the
/// extent.
const ORTHO_EPS: f64 = 1.0e-4;

/// Reject only a truly degenerate (zero-length or non-finite) vector — not a
/// scale-dependent magnitude threshold. `v` is a cross product of edge
/// vectors reconstructed from f32 mesh positions, so its length scales with
/// the *square* of the operand's own dimensions: a fixed absolute epsilon
/// here would silently drop every face-normal candidate for any operand
/// small enough that its triangle areas fall under that epsilon, collapsing
/// `orthogonal_face_axes` back to `None` (i.e. the world-axes-only fallback)
/// for small but perfectly valid box operands.
///
/// This function alone cannot distinguish "small but valid" from "sliver
/// noise" — both produce a small `len`, and length is exactly what scales
/// with the operand's own dimensions. That distinction needs the *relative*
/// test in [`face_normal`], which is why every caller that reconstructs a
/// face normal from triangle vertices goes through `face_normal`, not this
/// function directly. `normalize3` stays a plain building block, used
/// directly only where the input is already scale-free (e.g. crossing two
/// unit face-normal candidates in [`gate_axes`]).
fn normalize3(v: [f64; 3]) -> Option<[f64; 3]> {
    v3::normalize(v, 0.0)
}

/// Minimum `sin(θ)` between a triangle's two edges at the vertex the normal
/// is computed from, where θ is that triangle's interior angle there — a
/// **dimensionless** ratio (`|edge1 × edge2| / (|edge1| · |edge2|)`), not the
/// raw cross-product magnitude. A 1 mm box corner and a 100 m wall corner are
/// both right angles, θ = 90°, sin θ = 1, so this judges them identically —
/// which a length-based cutoff on the cross product cannot do, since that
/// magnitude scales with the *square* of the operand's own dimensions.
///
/// `Mesh::positions` is f32 (~1.2e-7 relative precision), so vertices
/// reconstructed from it carry noise of roughly that order. A genuinely
/// degenerate or near-collinear triangle (three points nearly on a line —
/// e.g. a stray sliver a tessellator emits alongside real box faces)
/// produces sin θ at or below that noise floor; its direction is unrelated
/// to any real geometric feature, verified by construction to swing across
/// dot products of −0.95 to 0.55 against the true face normal for sin θ in
/// the 1e-8 range. `1e-3` (θ ≈ 0.057°) sits three orders of magnitude above
/// that ~1e-7 noise floor while a genuine box-corner triangle sits at
/// sin θ = 1, eight orders of magnitude above the cutoff — so the cutoff
/// rejects noise with a wide margin on both sides regardless of the
/// operand's absolute size.
///
/// Rejected alternatives:
/// - An absolute length threshold on the cross product (the original bug):
///   fails exactly because it is not scale-free.
/// - No threshold at all (this file's prior state): admits ULP-noise
///   directions as described above.
/// - A threshold on the angle itself (`asin`/`acos`) instead of on sin θ:
///   equivalent near this range but costs an extra transcendental call for
///   no precision benefit this close to zero, where sin θ ≈ θ.
const MIN_SIN_THETA: f64 = 1.0e-3;

/// The unit normal of the triangle `(a, b, c)`, or `None` when the triangle
/// is degenerate (zero-length edge, non-finite input) or a sliver relative to
/// its own edge lengths (see [`MIN_SIN_THETA`]).
///
/// `sin θ` is measured at the triangle's LARGEST angle (the vertex between its
/// two shortest edges), so the verdict is a property of the triangle and not
/// of which vertex the index buffer lists first: a 10 m x 5 mm plate face
/// has `sin` ~5e-4 at an acute corner and 1 at the right-angle one, and an
/// `a`-relative test dropped it depending on winding start (same fix as
/// `ifc-lite-clash` `obb_detect::face_normal`, #7813).
fn face_normal(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> Option<[f64; 3]> {
    let len = |p: [f64; 3], q: [f64; 3]| {
        let d = v3::sub(q, p);
        v3::dot(d, d).sqrt()
    };
    let (ab, bc, ca) = (len(a, b), len(b, c), len(c, a));
    if !(ab.is_finite() && bc.is_finite() && ca.is_finite()) || ab == 0.0 || bc == 0.0 || ca == 0.0
    {
        return None;
    }
    // The two shortest edges meet at the largest angle.
    let longest = ab.max(bc).max(ca);
    let (l0, l1) = if longest == ab {
        (bc, ca)
    } else if longest == bc {
        (ab, ca)
    } else {
        (ab, bc)
    };
    let cross = v3::cross(v3::sub(b, a), v3::sub(c, a));
    let cross_len = v3::dot(cross, cross).sqrt();
    if !cross_len.is_finite() || cross_len == 0.0 {
        return None;
    }
    let sin_theta = cross_len / (l0 * l1);
    if !sin_theta.is_finite() || sin_theta < MIN_SIN_THETA {
        return None;
    }
    Some([cross[0] / cross_len, cross[1] / cross_len, cross[2] / cross_len])
}

/// Cap on distinct face-normal direction families collected per operand.
/// `gate_axes` crosses every family of `a` against every family of `b`
/// (`O(|families_a| · |families_b|)`), but this module runs on ONE selected
/// clash pair at a time, never the detection sweep (`clash_solid` module
/// docs, "On demand, never eager"), so a few thousand candidates cost
/// nothing a user would notice. The cap only bounds the pathological case of
/// a mesh with hundreds of mutually non-parallel triangle normals; an
/// ordinary `n`-gon extrusion contributes at most `n + 2` families, and 64
/// covers a 62-gon — finer than any real IFC profile tessellation.
///
/// The direction of error when the cap DOES bite, stated plainly because the
/// rest of this module is careful about it: truncating drops candidate axes,
/// and a dropped axis can only make the gate find LESS separation, so a
/// contact it would otherwise withhold can be admitted. That is the unsafe
/// direction — the opposite of the "gate-tightening only" property the
/// generalisation otherwise has.
///
/// It is nonetheless a strict improvement on every input, because the
/// alternative is not an uncapped scan: before this, `gate_axes` fell back to
/// the three WORLD axes for any operand that was not a perfect box (its own
/// doc called that "conservative, not correct"). A tessellated cylinder went
/// from 3 candidate axes to at least 64 per operand plus their crosses. So
/// the cap leaves the generalisation incomplete for meshes with more than 64
/// distinct normal families — a tessellated dome or a swept curved BREP, not
/// a profile extrusion — rather than making anything worse than it was.
const MAX_FACE_FAMILIES: usize = 64;

/// The distinct face-normal direction families of `m`: one canonical unit
/// direction per group of mutually-parallel (within `ORTHO_EPS`) triangle
/// face normals, in first-seen order, capped at `MAX_FACE_FAMILIES`.
///
/// Unlike a box-frame detector, this makes NO claim the families are
/// mutually perpendicular or that there are exactly three — it works for ANY
/// polyhedral mesh, box-shaped or not. A flat face is a legitimate candidate
/// contact-normal direction whether or not the rest of the mesh forms a
/// rectangular box: a chamfered beam end, a mitred pipe joint or an
/// arbitrary extruded profile still has flat faces, and the true contact
/// normal of a planar touch between two polyhedra is parallel to one of
/// those faces (see `gate_axes`).
fn face_axis_families(m: &Mesh) -> Vec<[f64; 3]> {
    let mut groups: Vec<[f64; 3]> = Vec::new();
    let vert = |i: u32| -> [f64; 3] {
        let o = (i as usize) * 3;
        [
            m.positions[o] as f64,
            m.positions[o + 1] as f64,
            m.positions[o + 2] as f64,
        ]
    };
    for t in m.indices.chunks_exact(3) {
        if groups.len() >= MAX_FACE_FAMILIES {
            break;
        }
        let (a, b, c) = (vert(t[0]), vert(t[1]), vert(t[2]));
        let n = match face_normal(a, b, c) {
            Some(n) => n,
            // Degenerate or sliver triangle: carries no face-normal evidence
            // either way.
            None => continue,
        };
        let cn = v3::canonical(n);
        if groups.iter().any(|g| v3::dot(*g, cn) > 1.0 - ORTHO_EPS) {
            continue;
        }
        groups.push(cn);
    }
    groups
}

/// The three mutually perpendicular face-normal directions of a box-shaped
/// operand, or `None` when the mesh's faces do not fall into exactly three
/// such families. A special case of [`face_axis_families`] (exactly 3
/// families, mutually orthogonal); kept `cfg(test)` for the box-specific
/// unit tests below, its only remaining caller — `gate_axes` calls the more
/// general function directly.
#[cfg(test)]
fn orthogonal_face_axes(m: &Mesh) -> Option<[[f64; 3]; 3]> {
    let groups = face_axis_families(m);
    if groups.len() != 3 {
        return None;
    }
    for i in 0..3 {
        for j in (i + 1)..3 {
            if v3::dot(groups[i], groups[j]).abs() > ORTHO_EPS {
                return None;
            }
        }
    }
    Some([groups[0], groups[1], groups[2]])
}

/// Unit directions the thickness is measured along.
///
/// Always the three world axes — the historical behaviour, and the floor,
/// never the ceiling: thickness is the MINIMUM extent over this set, so
/// every extra axis can only *lower* it and therefore only tighten the gate.
/// An added axis can withhold a solid that used to be returned; it can never
/// admit one that used to be withheld.
///
/// The set also carries EVERY distinct face-normal direction
/// ([`face_axis_families`]) of each operand, box-shaped or not, plus every
/// pairwise cross product between an `a`-family axis and a `b`-family axis.
/// For two boxes this reduces to the classical 15 OBB separating-axis
/// candidates the #2573 review's box-box fix introduced. For a non-box
/// operand — a chamfered beam end, a mitred pipe joint, an arbitrary profile
/// — it is the direct generalisation: that operand's own flat faces are
/// still legitimate candidate contact-normal directions, since the true
/// contact normal of a planar touch between two polyhedra is parallel to a
/// face of at least one of them. That closes the review's finding: a box vs.
/// a corner-chamfering tetrahedron now includes the tetrahedron's own
/// cut-face normal, not just the world axes.
///
/// Not a completeness guarantee for every contact — a genuinely curved
/// touch, or a true normal that is a cross product of edge directions no
/// face here exposes, is not derivable this way — so the blind spot is
/// narrowed, not eliminated. But an extra axis can only tighten the gate,
/// never certify a shallow contact as thick; where the true normal is not
/// among these candidates the world-axis floor still applies the module's
/// trust threshold, just without certainty the measured extent is the true
/// minimum. There is no cheaper analytic candidate left to add without
/// inventing a depth.
pub(crate) fn gate_axes(a: &Mesh, b: &Mesh) -> Vec<[f64; 3]> {
    let mut axes: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let fa = face_axis_families(a);
    let fb = face_axis_families(b);
    axes.extend_from_slice(&fa);
    axes.extend_from_slice(&fb);
    for u in &fa {
        for v in &fb {
            // Parallel axes cross to zero — not a separating-axis candidate.
            if let Some(n) = normalize3(v3::cross(*u, *v)) {
                axes.push(n);
            }
        }
    }
    axes
}

#[cfg(test)]
#[path = "clash_contact_axes_tests.rs"]
mod tests;
