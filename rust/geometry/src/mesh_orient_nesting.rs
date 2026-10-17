// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Containment between the closed shells of one mesh (#7755).
//!
//! A solid whose cavity is a separate shell (a full 2π revolution of a holed
//! profile: outer surface plus bore; a faceted brep with a void) has components
//! nested inside one another. A shell nested an ODD number of levels deep is a
//! cavity: its outward-facing normals point into the cavity, so its own signed
//! volume is negative and the mesh volume is `outer - bore`. The orienter used
//! to make every closed component positive, which turned the bore inside out
//! and read `outer + bore`.
//!
//! Containment is the winding number of the container at a point of the
//! candidate: the sum of the solid angles its triangles subtend, over 4π. It
//! is ±1 inside a consistently wound closed shell and 0 outside, and unlike a
//! ray-parity count it has no degenerate directions.

/// A point counts as inside only beyond this winding magnitude. A point ON the
/// container (two coincident duplicate shells) scores 0.5 up to rounding and
/// must stay "not inside", or the answer would depend on rounding noise.
const INSIDE_WINDING: f64 = 0.75;

/// Points of a candidate tested against each container.
const SAMPLES: usize = 8;

type Tri = [[f64; 3]; 3];

/// Wind every closed component (`spans`: `(start, end, own signed volume * 6)`
/// into `tris`) so its signed volume is positive, except a shell nested an odd
/// number of closed shells deep, which is wound into its cavity and so negative.
/// `flip` is each triangle's current flip; `corners(t, flipped)` its corners.
/// A lone closed component has nothing to nest in and skips the containment test.
pub(super) fn face_closed_components(
    spans: &[(usize, usize, f64)],
    tris: &[usize],
    flip: &mut [bool],
    corners: &dyn Fn(usize, bool) -> Tri,
) {
    let cavity: Option<Vec<bool>> = (spans.len() >= 2).then(|| {
        let members: Vec<&[usize]> = spans.iter().map(|&(s, e, _)| &tris[s..e]).collect();
        odd_depth_components(&members, &|t| corners(t, flip[t]))
    });
    for (i, &(s, e, vol6)) in spans.iter().enumerate() {
        let is_cavity = cavity.as_ref().is_some_and(|c| c[i]);
        if (vol6 < 0.0 && !is_cavity) || (vol6 > 0.0 && is_cavity) {
            for &t in &tris[s..e] {
                flip[t] = !flip[t];
            }
        }
    }
}

/// For each component (a list of triangle ids), whether it sits an odd number
/// of closed shells deep. `tri` gives a triangle's corners, consistently wound
/// within its component.
fn odd_depth_components(
    components: &[&[usize]],
    tri: &dyn Fn(usize) -> Tri,
) -> Vec<bool> {
    let boxes: Vec<([f64; 3], [f64; 3])> = components
        .iter()
        .map(|tris| {
            let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
            for &t in *tris {
                for p in tri(t) {
                    for k in 0..3 {
                        lo[k] = lo[k].min(p[k]);
                        hi[k] = hi[k].max(p[k]);
                    }
                }
            }
            (lo, hi)
        })
        .collect();
    components
        .iter()
        .enumerate()
        .map(|(c, tris)| {
            if tris.is_empty() {
                return false;
            }
            // Spread points of `c`: a shell is nested only when ALL of them are
            // inside, so one that merely overlaps another (a frame partly
            // embedded in a wall) is not taken for a cavity.
            let samples: Vec<[f64; 3]> = (0..SAMPLES)
                .map(|k| tri(tris[k * tris.len() / SAMPLES])[k % 3])
                .collect();
            let depth = (0..components.len())
                .filter(|&other| other != c)
                .filter(|&other| {
                    let (lo, hi) = boxes[other];
                    (0..3).all(|k| boxes[c].0[k] >= lo[k] && boxes[c].1[k] <= hi[k])
                })
                .filter(|&other| {
                    samples.iter().all(|&p| winding(components[other], tri, p).abs() > INSIDE_WINDING)
                })
                .count();
            depth % 2 == 1
        })
        .collect()
}

/// Winding number of the closed shell `tris` about `p`.
fn winding(tris: &[usize], tri: &dyn Fn(usize) -> Tri, p: [f64; 3]) -> f64 {
    let sub = |a: [f64; 3]| [a[0] - p[0], a[1] - p[1], a[2] - p[2]];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let norm = |a: [f64; 3]| dot(a, a).sqrt();
    let cross = |a: [f64; 3], b: [f64; 3]| {
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    };
    let total: f64 = tris
        .iter()
        .map(|&t| {
            let [a, b, c] = tri(t).map(sub);
            let (la, lb, lc) = (norm(a), norm(b), norm(c));
            let denom = la * lb * lc + dot(a, b) * lc + dot(b, c) * la + dot(c, a) * lb;
            // Van Oosterom-Strackee solid angle of the triangle seen from `p`.
            2.0 * dot(a, cross(b, c)).atan2(denom)
        })
        .sum();
    total / (4.0 * std::f64::consts::PI)
}
