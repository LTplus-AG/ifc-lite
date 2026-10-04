// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::super::broadphase::Aabb;
use super::super::predicates::orient3d;
use super::super::{ImplicitPoint, Sign};
use super::Tri;

// --- ray parity: sound far endpoint + exact inside test -------------------

#[inline]
fn e(p: [f64; 3]) -> ImplicitPoint {
    ImplicitPoint::Explicit(p)
}

/// EXACT segment–triangle intersection via `orient3d` (no epsilon): the segment
/// `q1→q2` crosses triangle `t` iff its endpoints straddle `t`'s plane AND the
/// line passes the same side of all three edges. A grazing hit (`orient3d == 0`)
/// is rejected — the fixed generic ray direction makes those vanishingly rare.
pub(super) fn exact_seg_hits_tri(q1: [f64; 3], q2: [f64; 3], t: &Tri) -> bool {
    let s1 = orient3d(&e(t[0]), &e(t[1]), &e(t[2]), &e(q1));
    let s2 = orient3d(&e(t[0]), &e(t[1]), &e(t[2]), &e(q2));
    if s1 == Sign::Zero || s2 == Sign::Zero || s1 == s2 {
        return false;
    }
    let ea = orient3d(&e(q1), &e(q2), &e(t[0]), &e(t[1]));
    let eb = orient3d(&e(q1), &e(q2), &e(t[1]), &e(t[2]));
    let ec = orient3d(&e(q1), &e(q2), &e(t[2]), &e(t[0]));
    ea != Sign::Zero && ea == eb && eb == ec
}

/// Ray-cast "far" distance: just past the operand's actual extent. Critically NOT
/// a huge constant (1e7) — that blows the orient3d float-filter error bound so
/// EVERY predicate escalates to BigRational (≈5000× slower). Sized to the operand,
/// the float filter resolves the common case and only true grazing escalates.
pub(super) fn operand_extent(tris: &[Tri]) -> f64 {
    let mut hi = 1.0f64;
    for t in tris {
        for v in t {
            for &c in v {
                hi = hi.max(c.abs());
            }
        }
    }
    2.0 * hi + 1.0
}

/// The fixed generic ray direction for parity casts. No two components
/// near-equal and no pairwise ratio near a simple architectural slope (1:1
/// roofs, axis planes). The previous direction had x≈y and dz/dx≈1 — nearly
/// PARALLEL to 45° roof slopes/ridge edges, so a roof-clipped wall's ray grazed
/// the roof and edge-crossings (rejected, not counted) miscounted parity → the
/// sub-ridge gable triangle was wrongly judged inside the cutter and removed
/// (the "missing wall" over-clip). Shared by [`point_inside`] and the
/// per-component AABB ray prefilter so they can never disagree.
pub(super) fn ray_dir() -> [f64; 3] {
    [0.301_511_3, 0.557_328_1, 0.773_890_1]
}

/// The parity segment's far endpoint, placed strictly outside `[lo, hi]` (the
/// AABB of the mesh being tested) - the soundness condition the parity argument
/// needs, and the one the pre-fix code did not have.
///
/// PRECONDITION: `far_l` must be commensurate with the box, which every caller
/// satisfies by passing `operand_extent` of the SAME mesh (that bounds
/// `esc / far_l` at about 3.3). Hand a `far_l` far smaller than the box and
/// `esc + far_l` is absorbed by f64 rounding, putting the endpoint back inside:
/// measured 33425 of 200000 at box scale 1e10 to 1e18 with `far_l` in [1, 10].
/// The assert below pins that, since the property is otherwise silent.
///
/// `far_l` is `operand_extent(other)`, sized from the coordinates of the OTHER
/// operand. But `p` is a centroid of THIS operand, and can sit outside that
/// envelope along `dir`. Then `p + dir*far_l` lands strictly INSIDE the other
/// solid: the segment counts the ENTRY crossing and never reaches the EXIT, odd
/// parity calls an outside point inside, and in a Difference the triangle is
/// dropped - deleting a whole face of the host and leaving an open shell. That
/// is issue #3341, where two boxes that merely TOUCH lose a face of the host,
/// and a purely DISJOINT pair does the same. The bug is the segment LENGTH; it
/// has nothing to do with touching or coplanarity.
///
/// When the default endpoint falls inside the AABB, walk out along `dir` to the
/// first face of the box it can escape through and add a `far_l` margin. Both
/// endpoints then lie outside the mesh, so both parities are valid; what the
/// extension buys is that the NEW one is reliably so.
///
/// Note what this does NOT claim. Extension fires whenever the old endpoint was
/// inside the AABB, which on a non-convex operand includes points inside the
/// bounding box but outside the solid, where the old parity was already correct.
/// Those queries do get a different, longer segment. The justification is not
/// that they are untouched, it is that both endpoints are outside the solid and
/// so both answers agree. Queries whose endpoint was ALREADY outside the AABB
/// keep a byte-identical segment, because the early return below is literally
/// the pre-fix expression.
///
/// The escape face is chosen per axis by `dir`'s sign, so this holds for any
/// direction and not only the all-positive [`ray_dir`]; pinned by
/// `classify_tests::the_extended_endpoint_clears_the_box_for_any_direction_sign`,
/// which also records why that generality is load-bearing.
///
/// FMA-free f64 throughout, so native and wasm stay bit-identical.
pub(super) fn sound_far(p: [f64; 3], dir: [f64; 3], far_l: f64, (lo, hi): Aabb) -> [f64; 3] {
    let far = [p[0] + dir[0] * far_l, p[1] + dir[1] * far_l, p[2] + dir[2] * far_l];
    if !(0..3).all(|i| far[i] >= lo[i] && far[i] <= hi[i]) {
        return far;
    }
    debug_assert!(
        (0..3).all(|i| !(hi[i] - lo[i]).is_finite() || hi[i] - lo[i] <= far_l * 4.0),
        "far_l={far_l} is too small for the box {lo:?}..{hi:?}; the escape margin \
         would be lost to rounding (see the precondition above)"
    );
    // Inside the box, so on every axis with a nonzero `dir` the ray escapes
    // through `hi` when moving up and `lo` when moving down; either way the
    // parameter is positive. An axis with `dir[i] == 0` never escapes and is
    // skipped. At least one axis has a nonzero component (`dir` is a unit
    // vector), so `esc` is finite.
    // The sign selects which FACE the ray escapes through, not which formula.
    let esc = (0..3)
        .filter(|&i| dir[i] != 0.0)
        .map(|i| ((if dir[i] > 0.0 { hi[i] } else { lo[i] }) - p[i]) / dir[i])
        .fold(f64::MAX, f64::min);
    let l2 = esc + far_l; // clears the escape face by >= |dir_i| * far_l
    [p[0] + dir[0] * l2, p[1] + dir[1] * l2, p[2] + dir[2] * l2]
}

/// Is point `p` inside the closed mesh `tris`? Exact ray-cast parity to a far
/// point (`far_l` past the extent, lengthened by [`sound_far`] whenever that
/// endpoint would land inside the mesh) along a fixed generic direction; each
/// crossing tested by the exact predicate above.
///
/// `aabb` must CONTAIN `tris`'s true box; every caller already holds one, so this
/// takes it rather than rescanning per query. A superset is verdict-identical:
/// [`sound_far`] only uses it to lengthen the far endpoint, and extending past the
/// real AABB crosses no further triangles, so parity is unchanged.
pub(super) fn point_inside(p: [f64; 3], tris: &[Tri], far_l: f64, aabb: Aabb) -> bool {
    if tris.is_empty() {
        return false; // no crossings to count
    }
    let far = sound_far(p, ray_dir(), far_l, aabb);
    tris.iter().filter(|t| exact_seg_hits_tri(p, far, t)).count() % 2 == 1
}
