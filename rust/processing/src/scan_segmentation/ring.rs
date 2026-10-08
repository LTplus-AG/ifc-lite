// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rings of adjacent vertical planes about a common axis (#6893): where a
//! column hides among the planes.
//!
//! Region growing claims a round column of r >= about 0.8 m (at the default
//! 3 cm voxel) as flat strips: each strip turns by less than the plane angle
//! tolerance, and the strips' bend (1 / r) is too small, and on noisy scans
//! too attenuated, to tell from a noisy wall (measured: 0.04..0.49 per metre
//! on r 1.5 strips at 8 mm noise, up to 0.65 on small wall planes). A
//! polygonal column is, correctly, one plane per face. Both are rings: seen
//! from above, each plane is a segment, and the perpendicular through its
//! middle passes through the column's axis (a chord's bisector on a circle,
//! the apothem on a regular polygon).
//!
//! Two vertical planes are linked when their segments' nearest ends lie
//! close (`LINK_GAP_VOXELS`, `LINK_GAP_SHARE`), their heights overlap by at least half the
//! shorter one, their faces turn by `MIN_TURN`..=`MAX_TURN` (a polygon of six
//! or more faces turns by at most 60 degrees, a wall corner by 90), and the
//! perpendiculars through their middles meet behind both faces, at distances
//! that agree and are within the largest cylinder radius (with the same
//! spread). Linked planes form
//! rings (union-find); a ring's centre is the least-squares meeting point of
//! its members' perpendiculars, and members whose distance from it disagrees
//! with the ring's leave it. Rings about one centre at one distance (one
//! column seen in pieces) join. The caller tries each ring as a round column
//! first, then as a faceted one (`prism`).
use super::grow::Region;
use super::normals::{dot, Vec3};
use super::options::Params;
use super::refit::plane_basis;
use super::voxel::VoxelSet;
use ifc_lite_geometry::UnionFind;
use std::f64::consts::PI;

pub(crate) type P2 = [f64; 2];

/// Plane segments whose nearest ends lie within this many voxels (plus the
/// distance tolerance and `LINK_GAP_SHARE` of the narrower segment) are
/// adjacent: growth leaves the voxels along a crease to neither face, and on
/// a noisy round column (8 mm on r 1.5) that band is 0.1..0.24 m wide, about
/// a third of a strip.
const LINK_GAP_VOXELS: f64 = 4.;
const LINK_GAP_SHARE: f64 = 0.5;
/// Faces turning by less are one wall with a step (coplanar faces merged
/// earlier); by more, a corner, not a column of six or more faces.
const MIN_TURN: f64 = 0.0524; // 3 degrees
const MAX_TURN: f64 = 1.134; // 65 degrees
/// Linked faces' distances from their meeting point agree within this share
/// (plus twice the distance tolerance): strips of unequal width on one round
/// column differ by under 3 %.
const APOTHEM_SPREAD: f64 = 0.15;

/// The plan frame: two horizontal unit axes and up.
#[derive(Clone, Copy)]
pub(crate) struct Plan {
    pub e1: Vec3,
    pub e2: Vec3,
    pub up: Vec3,
}

impl Plan {
    pub fn new(up: Vec3) -> Self {
        let (e1, e2) = plane_basis(up);
        Self { e1, e2, up }
    }
    pub fn project(&self, p: Vec3) -> P2 {
        [dot(p, self.e1), dot(p, self.e2)]
    }
    pub fn height(&self, p: Vec3) -> f64 {
        dot(p, self.up)
    }
    /// The 3D point at plan position `q` and height `h`.
    pub fn lift(&self, q: P2, h: f64) -> Vec3 {
        std::array::from_fn(|k| q[0] * self.e1[k] + q[1] * self.e2[k] + h * self.up[k])
    }
}

pub(crate) fn dot2(a: P2, b: P2) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}

fn sub2(a: P2, b: P2) -> P2 {
    [a[0] - b[0], a[1] - b[1]]
}

fn length2(a: P2) -> f64 {
    dot2(a, a).sqrt()
}

/// A vertical plane seen from above.
#[derive(Clone, Debug)]
pub(crate) struct Face {
    /// Index into the planes.
    pub plane: usize,
    /// Plan unit normal; outward (away from the centre) once in a ring.
    pub normal: P2,
    /// Middle of the plane's horizontal span, on its plan line.
    pub mid: P2,
    pub width: f64,
    /// Lowest and highest member voxel along up.
    pub heights: [f64; 2],
    ends: [P2; 2],
}

impl Face {
    fn of(plane: usize, region: &Region, voxels: &VoxelSet, plan: &Plan) -> Option<Self> {
        let n = plan.project(region.normal);
        let length = length2(n);
        if length < 1e-9 {
            return None;
        }
        let normal = [n[0] / length, n[1] / length];
        let tangent = [-normal[1], normal[0]];
        let offset = dot2(plan.project(region.centroid), normal);
        let (mut lo, mut hi, mut heights) = (f64::INFINITY, f64::NEG_INFINITY, [f64::INFINITY, f64::NEG_INFINITY]);
        for &i in &region.voxels {
            let p = voxels.means[i as usize];
            let s = dot2(plan.project(p), tangent);
            (lo, hi) = (lo.min(s), hi.max(s));
            let h = plan.height(p);
            heights = [heights[0].min(h), heights[1].max(h)];
        }
        let at = |s: f64| -> P2 { [offset * normal[0] + s * tangent[0], offset * normal[1] + s * tangent[1]] };
        Some(Self { plane, normal, mid: at((lo + hi) / 2.), width: hi - lo, heights, ends: [at(lo), at(hi)] })
    }
    fn height(&self) -> f64 {
        self.heights[1] - self.heights[0]
    }
}

/// A ring of faces about `centre`, outward normals, ordered by normal angle.
#[derive(Debug)]
pub(crate) struct Ring {
    pub faces: Vec<Face>,
    pub centre: P2,
    /// Median distance from the centre to the faces' lines.
    pub apothem: f64,
}

/// Whether `a` and `b` are neighbouring faces of one column.
fn linked(a: &Face, b: &Face, gap: f64, tolerance: f64, max_radius: f64) -> bool {
    let nearest = a.ends.iter().flat_map(|p| b.ends.iter().map(move |q| length2(sub2(*p, *q)))).fold(f64::INFINITY, f64::min);
    let overlap = a.heights[1].min(b.heights[1]) - a.heights[0].max(b.heights[0]);
    let turn = dot2(a.normal, b.normal).abs().min(1.).acos();
    if nearest > gap + LINK_GAP_SHARE * a.width.min(b.width) || overlap < 0.5 * a.height().min(b.height()) || !(MIN_TURN..=MAX_TURN).contains(&turn) {
        return false;
    }
    // Each normal turned away from the other face's middle: the side a
    // column's surface faces. The perpendiculars meet at the axis:
    // a.mid - p oa = b.mid - q ob.
    let away = |f: &Face, other: &Face| if dot2(sub2(other.mid, f.mid), f.normal) < 0. { f.normal } else { f.normal.map(|v| -v) };
    let (oa, ob) = (away(a, b), away(b, a));
    let r = sub2(a.mid, b.mid);
    let det = ob[0] * oa[1] - oa[0] * ob[1];
    if det.abs() < 1e-12 {
        return false;
    }
    let p = (ob[0] * r[1] - ob[1] * r[0]) / det;
    let q = (oa[0] * r[1] - oa[1] * r[0]) / det;
    // Two perpendiculars at a shallow angle cross imprecisely: a strip's
    // middle a centimetre off moves their crossing by several, so the radius
    // bound is the cylinder fit's to apply, not this one's.
    p > 0. && q > 0. && (p - q).abs() <= APOTHEM_SPREAD * p.max(q) + 2. * tolerance && p.max(q) <= (1. + APOTHEM_SPREAD) * max_radius
}

/// The least-squares meeting point of the perpendiculars through the faces'
/// middles (minimising the squared distances along each face).
fn centre(faces: &[Face]) -> Option<P2> {
    let (mut a, mut b) = ([[0.; 2]; 2], [0.; 2]);
    for f in faces {
        let t = [-f.normal[1], f.normal[0]];
        let along = dot2(f.mid, t);
        for i in 0..2 {
            for j in 0..2 {
                a[i][j] += t[i] * t[j];
            }
            b[i] += t[i] * along;
        }
    }
    let det = a[0][0] * a[1][1] - a[0][1] * a[1][0];
    (det.abs() > 1e-9).then(|| [(b[0] * a[1][1] - b[1] * a[0][1]) / det, (a[0][0] * b[1] - a[1][0] * b[0]) / det])
}

fn median(mut values: Vec<f64>) -> f64 {
    let mid = values.len() / 2;
    *values.select_nth_unstable_by(mid, f64::total_cmp).1
}

/// Fit the centre, turn normals outward and drop members whose distance
/// from the centre disagrees with the ring's (one refit). None when fewer
/// than two faces remain or the perpendiculars do not meet.
fn ring_of(mut faces: Vec<Face>, tolerance: f64) -> Option<Ring> {
    for _ in 0..2 {
        let c = centre(&faces)?;
        for f in faces.iter_mut() {
            if dot2(sub2(f.mid, c), f.normal) < 0. {
                f.normal = f.normal.map(|v| -v);
            }
        }
        let apothems: Vec<f64> = faces.iter().map(|f| dot2(sub2(f.mid, c), f.normal)).collect();
        let m = median(apothems.clone());
        let before = faces.len();
        let mut k = 0;
        faces.retain(|_| {
            k += 1;
            (apothems[k - 1] - m).abs() <= APOTHEM_SPREAD * m + 2. * tolerance
        });
        if faces.len() < 2 {
            return None;
        }
        if faces.len() == before {
            faces.sort_by(|x, y| x.normal[1].atan2(x.normal[0]).total_cmp(&y.normal[1].atan2(y.normal[0])).then(x.plane.cmp(&y.plane)));
            return Some(Ring { faces, centre: c, apothem: m });
        }
    }
    None
}

/// Rings among the vertical planes `regions` (indexed as the planes), in
/// order of their first plane.
pub(crate) fn find(regions: &[Region], voxels: &VoxelSet, params: &Params, plan: &Plan) -> Vec<Ring> {
    let Some(c) = &params.cylinders else { return Vec::new() };
    let widest = 2. * c.max_radius + 2. * voxels.size;
    let faces: Vec<Face> = regions
        .iter()
        .enumerate()
        .filter(|(_, r)| dot(r.normal, params.up).abs() <= params.sin_class)
        .filter_map(|(i, r)| Face::of(i, r, voxels, plan))
        .filter(|f| f.width <= widest && f.height() >= c.min_length)
        .collect();
    let gap = LINK_GAP_VOXELS * voxels.size + params.distance;
    let mut sets = UnionFind::new(faces.len());
    for i in 0..faces.len() {
        for j in i + 1..faces.len() {
            if linked(&faces[i], &faces[j], gap, params.distance, c.max_radius) {
                sets.union(i as u32, j as u32);
            }
        }
    }
    let mut members: Vec<Vec<Face>> = vec![Vec::new(); faces.len()];
    for (i, face) in faces.iter().enumerate() {
        members[sets.find(i as u32) as usize].push(face.clone());
    }
    let mut rings: Vec<Ring> = members.into_iter().filter(|m| m.len() >= 2).filter_map(|m| ring_of(m, params.distance)).collect();
    // One column seen in pieces (its strips missing where growth left the
    // surface to no plane, or behind an occluder): rings about one axis at
    // one distance join. Each join removes a ring, so this ends.
    'join: loop {
        for i in 0..rings.len() {
            for j in i + 1..rings.len() {
                let (a, b) = (&rings[i], &rings[j]);
                let spread = APOTHEM_SPREAD * a.apothem.max(b.apothem) + 2. * params.distance;
                if length2(sub2(a.centre, b.centre)) > spread || (a.apothem - b.apothem).abs() > spread {
                    continue;
                }
                let faces = rings[i].faces.iter().chain(&rings[j].faces).cloned().collect();
                let Some(joined) = ring_of(faces, params.distance) else { continue };
                rings[i] = joined;
                rings.remove(j);
                continue 'join;
            }
        }
        break;
    }
    rings
}

/// Voxels inside the ring's footprint (closer to the axis than the apothem
/// less a margin), from just below to just above its faces, over the cells
/// that footprint holds: about 0 for a solid column, about 1 where a floor
/// runs inside (a bay or a niche seen from the room).
pub(crate) fn interior_share(ring: &Ring, voxels: &VoxelSet, params: &Params, plan: &Plan) -> f64 {
    let margin = 2. * voxels.size + params.distance;
    let inner = ring.apothem - margin;
    if inner <= voxels.size {
        return 0.;
    }
    let (lo, hi) = ring.faces.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), f| (lo.min(f.heights[0]), hi.max(f.heights[1])));
    let (lo, hi) = (lo - margin, hi + margin);
    let corners = [plan.lift(ring.centre, lo), plan.lift(ring.centre, hi)];
    let mut inside = 0_u64;
    voxels.for_each_in_box(corners, inner, |k| {
        let p = voxels.means[k as usize];
        let q = plan.project(p);
        let h = plan.height(p);
        if (lo..=hi).contains(&h) && (q[0] - ring.centre[0]).hypot(q[1] - ring.centre[1]) < inner {
            inside += 1;
        }
    });
    let cells = PI * inner * inner / (voxels.size * voxels.size);
    inside as f64 / cells
}

#[cfg(test)]
#[path = "ring_tests.rs"]
mod tests;
