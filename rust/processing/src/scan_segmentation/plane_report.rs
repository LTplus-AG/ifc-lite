// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Area, in-plane extent, classification and facing side of a final region.
use super::grow::Region;
use super::extent;
use super::normals::{canonical_sign, dot, sub, Vec3};
use super::options::Params;
use super::report::{NormalSource, PlaneExtent, PlaneOrientation, ScanPlane};
use super::voxel::VoxelSet;

/// Area from the voxel lattice itself: the distinct voxel columns along the
/// normal's dominant axis, each `size^2`, divided by that axis' share of the
/// normal (a tilted plane's footprint is foreshortened by it). Counting lattice
/// columns rather than binning the jittered means avoids aliasing.
pub(crate) fn area(region: &Region, voxels: &VoxelSet) -> f64 {
    let n = region.normal;
    let mut axis = 0;
    for a in 1..3 {
        if n[a].abs() > n[axis].abs() {
            axis = a;
        }
    }
    let (p, q) = ((axis + 1) % 3, (axis + 2) % 3);
    let mut cells: Vec<(i32, i32)> = region
        .voxels
        .iter()
        .map(|&i| {
            let key = voxels.keys[i as usize];
            (key[p], key[q])
        })
        .collect();
    cells.sort_unstable();
    cells.dedup();
    // A sampling gap one cell wide is surface, not an opening: count an empty
    // cell when at least three of its four edge neighbours are occupied.
    let occupied = |c: (i32, i32)| cells.binary_search(&c).is_ok();
    let mut gaps: Vec<(i32, i32)> = cells
        .iter()
        .flat_map(|&(a, b)| [(a - 1, b), (a + 1, b), (a, b - 1), (a, b + 1)])
        .filter(|&(a, b)| {
            !occupied((a, b))
                && [(a - 1, b), (a + 1, b), (a, b - 1), (a, b + 1)].into_iter().filter(|c| occupied(*c)).count() >= 3
        })
        .collect();
    gaps.sort_unstable();
    gaps.dedup();
    (cells.len() + gaps.len()) as f64 * voxels.size * voxels.size / n[axis].abs()
}

fn orientation(normal: Vec3, params: &Params) -> PlaneOrientation {
    let along_up = dot(normal, params.up).abs();
    if along_up >= params.cos_class {
        PlaneOrientation::Horizontal
    } else if along_up <= params.sin_class {
        PlaneOrientation::Vertical
    } else {
        PlaneOrientation::Sloped
    }
}

pub(crate) fn describe(region: &Region, voxels: &VoxelSet, area: f64, params: &Params) -> ScanPlane {
    let kind = orientation(region.normal, params);
    let (normal, normal_source) = match params.scanner {
        Some(scanner) if dot(sub(scanner, region.centroid), region.normal) < 0. => (region.normal.map(|x| -x), NormalSource::Scanner),
        Some(_) => (region.normal, NormalSource::Scanner),
        None if kind == PlaneOrientation::Horizontal => {
            let up = if dot(region.normal, params.up) < 0. { region.normal.map(|x| -x) } else { region.normal };
            (up, NormalSource::Canonical)
        }
        None => (canonical_sign(region.normal), NormalSource::Canonical),
    };
    let members = region.voxels.iter().map(|&i| sub(voxels.means[i as usize], region.centroid));
    let (u, v) = extent::axes(normal, kind == PlaneOrientation::Horizontal, params.up, members);
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    let (mut squares, mut points) = (0., 0_u64);
    for &i in &region.voxels {
        let d = sub(voxels.means[i as usize], region.centroid);
        for (axis, value) in [dot(d, u), dot(d, v)].into_iter().enumerate() {
            lo[axis] = lo[axis].min(value);
            hi[axis] = hi[axis].max(value);
        }
        squares += dot(d, normal).powi(2);
        points += u64::from(voxels.counts[i as usize]);
    }
    let origin = params.origin;
    let world = |p: Vec3| -> Vec3 { std::array::from_fn(|k| p[k] + origin[k]) };
    let at = |s: f64, t: f64| world(std::array::from_fn(|k| region.centroid[k] + s * u[k] + t * v[k]));
    let centroid = world(region.centroid);
    ScanPlane {
        normal,
        d: -dot(normal, centroid),
        centroid,
        inlier_points: points,
        inlier_voxels: region.voxels.len() as u32,
        area_square_metres: area,
        rms_metres: (squares / region.voxels.len() as f64).sqrt(),
        extent: PlaneExtent {
            center: at((lo[0] + hi[0]) / 2., (lo[1] + hi[1]) / 2.),
            u_axis: u,
            v_axis: v,
            u_length: hi[0] - lo[0],
            v_length: hi[1] - lo[1],
            corners: [at(lo[0], lo[1]), at(hi[0], lo[1]), at(hi[0], hi[1]), at(lo[0], hi[1])],
        },
        orientation: kind,
        normal_source,
    }
}
