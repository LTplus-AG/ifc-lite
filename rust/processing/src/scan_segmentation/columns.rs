// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Columns and pipes, with explicit precedence over planes (#6870, #6893).
//!
//! 1. Rings of vertical planes (`ring`) with scanned surface inside their
//!    footprint are dropped (a bay or a niche seen from the room: the floor
//!    runs inside it; a solid column hides its footprint).
//! 2. Each remaining ring's planes are searched as a round surface first
//!    (seeded with the ring's axis), then the non-planar groups (`cylinder`).
//! 3. A candidate refused only for its arc, pooled with the coaxial refused
//!    candidates of a similar radius and the planes lying on it, is searched
//!    again (`pools`): a wide column whose strip planes cut its non-planar
//!    voxels into arcs too narrow to pass alone. Duplicates are reduced and
//!    pieces joined (`cylinder_merge`).
//! 4. Precedence: a column wins over the planes it is made of. Every plane
//!    whose voxels lie on a round cylinder (at least `ABSORB_SHARE` within
//!    the distance tolerance of its surface, normals radial) leaves the plane
//!    output and joins the cylinder's inliers; its arc, extent and RMS are
//!    measured again over them.
//! 5. A ring that yielded no cylinder and kept all its planes is tried as a
//!    faceted column (`prism`); its faces leave the plane output. Duplicates
//!    are reduced once more (a faceted column and a round fit of its
//!    creases). So a surface is reported once.
use super::cylinder::{self, describe, radial_rms, Found, MAX_JOIN_GAP};
use super::cylinder_fit::{arc_degrees, Cylinder};
use super::cylinder_merge::{coaxial, similar_radius, suppress_duplicates};
use super::grow::Region;
use super::normals::{dot, sub, Normals, Vec3};
use super::options::Params;
use super::prism::prism;
use super::report::{ScanCylinder, ScanSegmentationStats};
use super::ring::{self, interior_share, Plan, Ring};
use super::voxel::VoxelSet;

/// A ring whose footprint holds more scanned voxels than this share of one
/// full layer of its cells is hollow.
const MAX_INTERIOR_SHARE: f64 = 0.1;
/// A plane is part of a round cylinder when this share of its voxels fits it.
const ABSORB_SHARE: f64 = 0.8;

pub(crate) struct Columns {
    pub cylinders: Vec<ScanCylinder>,
    /// Per plane: still reported (not absorbed into a cylinder).
    pub keep: Vec<bool>,
    pub limit_hit: bool,
}

/// The ring's planes' voxels, ascending, with the ring's vertical axis and the
/// median distance of those voxels from it as the first candidate (on a wide
/// column two noisy normals cross too imprecisely to seed RANSAC well).
fn ring_group(ring: &Ring, regions: &[Region], voxels: &VoxelSet, plan: &Plan) -> (Vec<u32>, Cylinder) {
    let mut members: Vec<u32> = ring.faces.iter().flat_map(|f| regions[f.plane].voxels.iter().copied()).collect();
    members.sort_unstable();
    members.dedup();
    let mut distances: Vec<f64> = members
        .iter()
        .map(|&i| {
            let q = plan.project(voxels.means[i as usize]);
            (q[0] - ring.centre[0]).hypot(q[1] - ring.centre[1])
        })
        .collect();
    let mid = distances.len() / 2;
    let radius = *distances.select_nth_unstable_by(mid, f64::total_cmp).1;
    (members, Cylinder { point: plan.lift(ring.centre, 0.), axis: plan.up, radius })
}

/// Cylinders (round and faceted) and which planes they leave reported;
/// `regions` are the accepted planes, `planar` their voxels.
pub(crate) fn detect(
    voxels: &VoxelSet,
    normals: &Normals,
    regions: &[Region],
    planar: &[bool],
    params: &Params,
    stats: &mut ScanSegmentationStats,
) -> Columns {
    let plan = Plan::new(params.up);
    let mut rings = ring::find(regions, voxels, params, &plan);
    stats.plane_rings = rings.len() as u64;
    rings.retain(|r| {
        let hollow = interior_share(r, voxels, params, &plan) > MAX_INTERIOR_SHARE;
        stats.plane_rings_rejected_as_hollow += u64::from(hollow);
        !hollow
    });
    let groups: Vec<(Vec<u32>, Cylinder)> = rings.iter().map(|r| ring_group(r, regions, voxels, &plan)).collect();
    let detected = cylinder::detect(voxels, normals, planar, params, groups, stats);
    let mut keep = vec![true; regions.len()];
    let gap = MAX_JOIN_GAP + 2. * voxels.size;
    let mut found = detected.found;
    let pooled = pools(detected.partials, regions, voxels, normals, params);
    found.extend(cylinder::detect_seeded(voxels, normals, planar, params, pooled, stats));
    let mut found = suppress_duplicates(found, gap, voxels.size, params.up, stats);
    absorb_planes(&mut found, regions, &mut keep, voxels, normals, params, stats);
    let mut faceted = 0;
    for (ring, hit) in rings.iter().zip(detected.ring_hits) {
        // A ring a round cylinder found, or whose planes one absorbed, is done.
        if hit || ring.faces.iter().any(|f| !keep[f.plane]) {
            continue;
        }
        match prism(ring, regions, voxels, params, &plan) {
            Some(column) => {
                for face in &ring.faces {
                    keep[face.plane] = false;
                }
                stats.planes_absorbed_into_cylinders += ring.faces.len() as u64;
                found.push(column);
                faceted += 1;
            }
            None => stats.plane_rings_rejected_as_irregular += 1,
        }
    }
    if faceted > 0 {
        found = suppress_duplicates(found, gap, voxels.size, params.up, stats);
    }
    Columns { cylinders: cylinder::ordered(found), keep, limit_hit: detected.limit_hit }
}

/// Move every still-reported plane lying on a round cylinder into it.
fn absorb_planes(
    found: &mut [Found],
    regions: &[Region],
    keep: &mut [bool],
    voxels: &VoxelSet,
    normals: &Normals,
    params: &Params,
    stats: &mut ScanSegmentationStats,
) {
    let tolerance = params.distance;
    let normal_of = |i: u32| normals.valid(i).then(|| normals.normal[i as usize]);
    if found.iter().all(|f| f.out.faceted.is_some()) {
        return;
    }
    let reach: Vec<f64> = regions.iter().map(|r| reach(r, voxels)).collect();
    for f in found.iter_mut().filter(|f| f.out.faceted.is_none()) {
        let mut grown = false;
        for (p, region) in regions.iter().enumerate() {
            // Only a plane whose centroid lies within its reach of the
            // surface can have members on it.
            if !keep[p] || (f.cylinder.radial(region.centroid).0 - f.cylinder.radius).abs() > reach[p] {
                continue;
            }
            if !lies_on(&f.cylinder, region, voxels, &normal_of, tolerance) {
                continue;
            }
            keep[p] = false;
            stats.planes_absorbed_into_cylinders += 1;
            f.inliers.extend_from_slice(&region.voxels);
            grown = true;
        }
        if grown {
            f.inliers.sort_unstable();
            f.inliers.dedup();
            let points: Vec<Vec3> = f.inliers.iter().map(|&i| voxels.means[i as usize]).collect();
            let arc = arc_degrees(&f.cylinder, points.iter().copied());
            f.out = describe(&f.cylinder, &f.inliers, voxels, radial_rms(&f.cylinder, &points), arc, params);
        }
    }
}

/// Whether at least `ABSORB_SHARE` of the plane's voxels fit the cylinder.
/// Stops at the first miss beyond the allowed share: a floor or a wall far
/// off the surface misses at once, and every refused arc on a real scan is
/// tested against every plane its reach allows (on a 2 M point apartment
/// scan at a 2 cm voxel, 131 candidates; a full count cost 0.36 s).
fn lies_on(cylinder: &Cylinder, region: &Region, voxels: &VoxelSet, normal_of: &dyn Fn(u32) -> Option<Vec3>, tolerance: f64) -> bool {
    let n = region.voxels.len();
    let allowed = n - (ABSORB_SHARE * n as f64).ceil() as usize;
    let mut misses = 0;
    for &i in &region.voxels {
        if !cylinder.fits(voxels.means[i as usize], normal_of(i), tolerance) {
            misses += 1;
            if misses > allowed {
                return false;
            }
        }
    }
    true
}

/// Pieces of one wide column cut apart by its own strip planes (each piece
/// then covers under the minimum arc): every candidate refused only for its
/// arc, most inliers first, pooled with the coaxial refused candidates of a
/// similar radius and the planes lying on it, to be searched again from it.
/// A candidate with nothing to add was judged already and is not repeated.
fn pools(
    mut partials: Vec<(Cylinder, Vec<u32>)>,
    regions: &[Region],
    voxels: &VoxelSet,
    normals: &Normals,
    params: &Params,
) -> Vec<(Vec<u32>, Cylinder)> {
    let normal_of = |i: u32| normals.valid(i).then(|| normals.normal[i as usize]);
    partials.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.1[0].cmp(&b.1[0])));
    let reach: Vec<f64> = if partials.is_empty() { Vec::new() } else { regions.iter().map(|r| reach(r, voxels)).collect() };
    let mut used = vec![false; partials.len()];
    let mut out = Vec::new();
    for i in 0..partials.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let seed = partials[i].0;
        let mut members = partials[i].1.clone();
        let before = members.len();
        for j in i + 1..partials.len() {
            if !used[j] && coaxial(&seed, &partials[j].0) && similar_radius(&seed, &partials[j].0) {
                used[j] = true;
                members.extend_from_slice(&partials[j].1);
            }
        }
        for (p, region) in regions.iter().enumerate() {
            let near = (seed.radial(region.centroid).0 - seed.radius).abs() <= reach[p];
            if near && lies_on(&seed, region, voxels, &normal_of, params.distance) {
                members.extend_from_slice(&region.voxels);
            }
        }
        if members.len() > before {
            members.sort_unstable();
            members.dedup();
            out.push((members, seed));
        }
    }
    out
}

/// The farthest a member voxel lies from the region's centroid, plus a voxel.
fn reach(region: &Region, voxels: &VoxelSet) -> f64 {
    let farthest = region.voxels.iter().map(|&i| {
        let d = sub(voxels.means[i as usize], region.centroid);
        dot(d, d)
    });
    farthest.fold(0_f64, f64::max).sqrt() + voxels.size
}
