// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cylinders among the voxels no plane claimed (#6870), and among the planes
//! of rings that may be a wide column split into strips (#6893).
//!
//! 1. Voxels clear of every plane (neither planar nor next to a planar
//!    voxel) with normals form groups, connected over the 26 neighbours where
//!    adjacent normals turn by at most 35 degrees. Ring groups (the voxels of
//!    a ring of planes, `ring`) are searched first, in the same way.
//! 2. Per group, largest first: a seeded RANSAC (`cylinder_fit::ransac`).
//!    Two voxels whose normals are at least 30 degrees from parallel define a
//!    candidate. The axis is `n1 x n2`, and the axis line and radius come from
//!    the closest approach of the two normal lines. Each draw is scored on an
//!    evenly strided subsample. A ring group, or a pool of pieces
//!    (`columns`), tries its own seed candidate first.
//! 3. The best candidate is refitted by least squares (`cylinder_fit`) and
//!    kept when the refit fits at least `min_cylinder_inlier_fraction` of the
//!    group. It is refused when its radius is out of range (the minimum
//!    defaults to two voxels), when a sphere fits its inliers as well, when
//!    they cover less than the minimum arc, when they are shorter than the
//!    minimum length, when their normals do not turn around the axis as a
//!    cylinder's do (flat facets meeting at an angle), or when fewer than half
//!    its axial slices agree with the widest slice's arc (clutter showing
//!    different fragments at different heights); see `cylinder_guards`. Its
//!    inliers then leave the group, and the next candidate is sought; at most
//!    `MAX_PER_GROUP` tries per group. Every exit is counted in the stats.
//! 4. Candidates refused only for their arc are returned as partials; the
//!    caller (`columns`) pools and re-searches them, reduces near-identical
//!    cylinders, joins coaxial pieces (`cylinder_merge`), gives columns
//!    precedence over planes and adds faceted columns.
//!
//! Every loop is bounded: groups by `max_cylinder_groups`, draws by
//! `cylinder_draws`, scoring by `cylinder_score_sample`, refits by fixed pass
//! counts. The RNG is seeded per group from its first voxel, and voxels are
//! ordered by key, so results do not depend on point order.
use super::cylinder_fit::{arc_degrees, ransac, refine, sphere_rms, Cylinder};
use super::cylinder_guards::{coverage, looks_faceted, pierced_share, slice_agreement};
use super::normals::{canonical_sign, dot, sub, Normals, Vec3};
use super::options::{CylinderParams, Params};
use super::report::{AxisOrientation, ScanCylinder, ScanSegmentationStats};
use super::voxel::VoxelSet;

const GROUP_COS: f64 = 0.819; // cos 35 degrees
const MIN_GROUP_VOXELS: usize = 20;
const MAX_PER_GROUP: usize = 4;
/// Coaxial pieces of one radius separated by up to this (plus two voxels for
/// the rows lost at each edge) along the axis are one column with a band of
/// missing points (occlusion, scanner shadow), not two cylinders.
pub(crate) const MAX_JOIN_GAP: f64 = 0.3;
/// Share of axial slices whose arc must agree with the widest slice's arc;
/// see `cylinder_guards::slice_agreement`.
const MIN_SLICE_AGREEMENT: f64 = 0.5;
/// Planes may pierce the inside of a candidate over at most this share of its
/// length (a pipe through a wall is pierced over the wall's thickness only);
/// see `cylinder_guards::pierced_share`.
const MAX_PIERCED_SHARE: f64 = 0.5;
/// Inliers must cover at least this share of the patch their length and arc
/// claim; see `cylinder_guards::coverage`.
const MIN_COVERAGE: f64 = 0.4;

/// Smoothly connected groups of voxels clear of every plane, with at least
/// `MIN_GROUP_VOXELS`,
/// largest first (ties by first voxel).
fn groups(voxels: &VoxelSet, normals: &Normals, planar: &[bool]) -> Vec<Vec<u32>> {
    // Voxels on or next to a plane stay out: the rounded crease along a
    // wall/floor junction would otherwise chain every column standing near a
    // wall into one room-sized group whose cylinder share is too low (a column
    // 3 cm from a corner was never found), and would pass for a thin pipe.
    let eligible: Vec<bool> = (0..voxels.len() as u32)
        .map(|i| {
            let mut touches = planar[i as usize];
            voxels.for_each_neighbor(i, 1, |j| touches |= planar[j as usize]);
            !touches && normals.valid(i)
        })
        .collect();
    let mut seen = vec![false; voxels.len()];
    let mut out = Vec::new();
    for start in 0..voxels.len() as u32 {
        if seen[start as usize] || !eligible[start as usize] {
            continue;
        }
        seen[start as usize] = true;
        let mut members = vec![start];
        let mut cursor = 0;
        while cursor < members.len() {
            let current = members[cursor];
            cursor += 1;
            let n = normals.normal[current as usize];
            voxels.for_each_neighbor(current, 1, |j| {
                let ju = j as usize;
                if !seen[ju] && eligible[ju] && dot(normals.normal[ju], n).abs() >= GROUP_COS {
                    seen[ju] = true;
                    members.push(j);
                }
            });
        }
        if members.len() >= MIN_GROUP_VOXELS {
            members.sort_unstable();
            out.push(members);
        }
    }
    out.sort_by(|a, b| b.len().cmp(&a.len()).then(a[0].cmp(&b[0])));
    out
}

/// An accepted cylinder: its report, its geometry and its inlier voxels.
pub(crate) struct Found {
    pub out: ScanCylinder,
    pub cylinder: Cylinder,
    pub inliers: Vec<u32>,
}

/// Cylinders found in the ring groups and in the non-planar groups.
pub(crate) struct Detected {
    pub found: Vec<Found>,
    /// Candidates refused only for a narrow arc, with their inliers: pieces
    /// of a wide column that its strip planes cut apart (see `columns`).
    pub partials: Vec<(Cylinder, Vec<u32>)>,
    /// Per ring group: whether it yielded a cylinder.
    pub ring_hits: Vec<bool>,
    /// The group budget cut the search short.
    pub limit_hit: bool,
}

/// What every group search shares.
struct Search<'a> {
    voxels: &'a VoxelSet,
    normals: &'a Normals,
    planar: &'a [bool],
    params: &'a Params,
    c: &'a CylinderParams,
    min_radius: f64,
}

impl<'a> Search<'a> {
    /// None without cylinder detection, or when no radius is acceptable.
    fn new(voxels: &'a VoxelSet, normals: &'a Normals, planar: &'a [bool], params: &'a Params) -> Option<Self> {
        let c = params.cylinders.as_ref()?;
        // Below two voxels a circumference has too few voxels to carry its curvature.
        let min_radius = c.min_radius.unwrap_or(2. * voxels.size);
        (min_radius <= c.max_radius).then_some(Self { voxels, normals, planar, params, c, min_radius })
    }

    fn normal_of(&self, i: u32) -> Option<Vec3> {
        self.normals.valid(i).then(|| self.normals.normal[i as usize])
    }

    /// Up to `MAX_PER_GROUP` cylinders from one group, appended to `found`;
    /// whether any was. A `seed` (a ring's axis and radius) is the first
    /// candidate; RANSAC draws the rest.
    fn group(&self, mut members: Vec<u32>, mut seed: Option<Cylinder>, stats: &mut ScanSegmentationStats, out: &mut Detected) -> bool {
        let found = &mut out.found;
        let (voxels, c, tolerance) = (self.voxels, self.c, self.params.distance);
        let normal_of = |i: u32| self.normal_of(i);
        let before = found.len();
        // A ring group's own plane voxels never pierce it (sorted, like every
        // group); a non-planar group has none.
        let own = if seed.is_some() { members.clone() } else { Vec::new() };
        for _ in 0..MAX_PER_GROUP {
            if members.len() < MIN_GROUP_VOXELS {
                break;
            }
            let Some(candidate) = seed.take().or_else(|| ransac(&members, voxels, self.normals, c, self.min_radius, tolerance).map(|(c, _)| c)) else {
                stats.cylinder_candidates_below_share += 1;
                break;
            };
            let Some((cylinder, inliers)) = refine(candidate, &members, &voxels.means, &normal_of, tolerance) else {
                stats.cylinder_refits_failed += 1;
                break;
            };
            // The share is judged on the least-squares refit: the best raw
            // draw of a noisy pipe can sit a centimetre off and fit too few.
            if (inliers.len() as f64) < c.min_fraction * members.len() as f64 {
                stats.cylinder_candidates_below_share += 1;
                break;
            }
            members.retain(|i| inliers.binary_search(i).is_err());
            if cylinder.radius < self.min_radius || cylinder.radius > c.max_radius {
                stats.cylinders_rejected_for_radius += 1;
                continue;
            }
            let points: Vec<Vec3> = inliers.iter().map(|&i| voxels.means[i as usize]).collect();
            let rms = radial_rms(&cylinder, &points);
            if sphere_rms(&points).is_some_and(|sphere| sphere <= rms) {
                stats.cylinders_rejected_as_spheres += 1;
                continue;
            }
            let arc = arc_degrees(&cylinder, points.iter().copied());
            if arc < c.min_arc {
                stats.cylinders_rejected_for_arc += 1;
                out.partials.push((cylinder, inliers));
                continue;
            }
            if slice_agreement(&cylinder, &inliers, voxels) < MIN_SLICE_AGREEMENT {
                stats.cylinders_rejected_for_uneven_arc += 1;
                continue;
            }
            if coverage(&cylinder, &inliers, voxels, arc) < MIN_COVERAGE {
                stats.cylinders_rejected_as_sparse += 1;
                continue;
            }
            if pierced_share(&cylinder, &inliers, voxels, self.planar, &own, tolerance) > MAX_PIERCED_SHARE {
                stats.cylinders_rejected_as_pierced += 1;
                continue;
            }
            if looks_faceted(&cylinder, &inliers, voxels, self.params.rings, &normal_of) {
                stats.cylinders_rejected_as_facets += 1;
                continue;
            }
            let out = describe(&cylinder, &inliers, voxels, rms, arc, self.params);
            if out.length < c.min_length {
                stats.cylinders_rejected_for_length += 1;
                continue;
            }
            found.push(Found { out, cylinder, inliers });
        }
        found.len() > before
    }
}

/// RMS radial distance of `points` from the cylinder's surface.
pub(crate) fn radial_rms(cylinder: &Cylinder, points: &[Vec3]) -> f64 {
    let squares: f64 = points.iter().map(|&p| (cylinder.radial(p).0 - cylinder.radius).powi(2)).sum();
    (squares / points.len() as f64).sqrt()
}

/// Cylinders in `ring_groups` (searched first, each from its ring's axis
/// and radius) and among the non-planar voxels, before duplicates are
/// reduced (`cylinder_merge`).
pub(crate) fn detect(
    voxels: &VoxelSet,
    normals: &Normals,
    planar: &[bool],
    params: &Params,
    ring_groups: Vec<(Vec<u32>, Cylinder)>,
    stats: &mut ScanSegmentationStats,
) -> Detected {
    let mut out = Detected { found: Vec::new(), partials: Vec::new(), ring_hits: vec![false; ring_groups.len()], limit_hit: false };
    let Some(c) = &params.cylinders else { return out };
    let mut groups = groups(voxels, normals, planar);
    out.limit_hit = groups.len() > c.max_groups;
    groups.truncate(c.max_groups);
    stats.cylinder_groups = groups.len() as u64;
    let Some(search) = Search::new(voxels, normals, planar, params) else {
        // An unset minimum is two voxels, which can exceed the maximum (a
        // small maximum, or a voxel coarsened by the budget): no radius is
        // acceptable, and every group is refused for radius rather than read
        // as a misfit.
        stats.cylinders_rejected_for_radius += groups.len() as u64;
        return out;
    };
    let mut hits = std::mem::take(&mut out.ring_hits);
    for (hit, (members, seed)) in hits.iter_mut().zip(ring_groups) {
        *hit = search.group(members, Some(seed), stats, &mut out);
    }
    out.ring_hits = hits;
    for members in groups {
        search.group(members, None, stats, &mut out);
    }
    out
}

/// Cylinders in groups each searched from its own first candidate.
pub(crate) fn detect_seeded(
    voxels: &VoxelSet,
    normals: &Normals,
    planar: &[bool],
    params: &Params,
    groups: Vec<(Vec<u32>, Cylinder)>,
    stats: &mut ScanSegmentationStats,
) -> Vec<Found> {
    let mut out = Detected { found: Vec::new(), partials: Vec::new(), ring_hits: Vec::new(), limit_hit: false };
    if let Some(search) = Search::new(voxels, normals, planar, params) {
        for (members, seed) in groups {
            search.group(members, Some(seed), stats, &mut out);
        }
    }
    out.found
}

/// The reports, longest first (ties by axis start).
pub(crate) fn ordered(found: Vec<Found>) -> Vec<ScanCylinder> {
    let mut out: Vec<ScanCylinder> = found.into_iter().map(|f| f.out).collect();
    out.sort_by(|a, b| {
        b.length.total_cmp(&a.length).then_with(|| {
            a.axis_start.iter().zip(&b.axis_start).fold(std::cmp::Ordering::Equal, |o, (x, y)| o.then(x.total_cmp(y)))
        })
    });
    out
}

pub(crate) fn describe(cylinder: &Cylinder, inliers: &[u32], voxels: &VoxelSet, rms: f64, arc: f64, params: &Params) -> ScanCylinder {
    let along_up = dot(cylinder.axis, params.up);
    let orientation = if along_up.abs() >= params.cos_class {
        AxisOrientation::Vertical
    } else if along_up.abs() <= params.sin_class {
        AxisOrientation::Horizontal
    } else {
        AxisOrientation::Sloped
    };
    let axis = match orientation {
        AxisOrientation::Horizontal => canonical_sign(cylinder.axis),
        _ if along_up < 0. => cylinder.axis.map(|v| -v),
        _ => cylinder.axis,
    };
    let (mut lo, mut hi, mut points) = (f64::INFINITY, f64::NEG_INFINITY, 0_u64);
    for &i in inliers {
        let t = dot(sub(voxels.means[i as usize], cylinder.point), axis);
        lo = lo.min(t);
        hi = hi.max(t);
        points += u64::from(voxels.counts[i as usize]);
    }
    let at = |t: f64| -> Vec3 { std::array::from_fn(|k| cylinder.point[k] + t * axis[k] + params.origin[k]) };
    let (start, end) = (at(lo), at(hi));
    let (h0, h1) = (dot(start, params.up), dot(end, params.up));
    ScanCylinder {
        axis_start: start,
        axis_end: end,
        axis_direction: axis,
        radius: cylinder.radius,
        length: hi - lo,
        height_range: [h0.min(h1), h0.max(h1)],
        arc_degrees: arc,
        inlier_points: points,
        inlier_voxels: inliers.len() as u32,
        rms_metres: rms,
        orientation,
        faceted: None,
    }
}
