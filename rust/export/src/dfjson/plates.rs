// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-space plate extraction: one floor ring + heights per `IfcSpace`.

use ifc_lite_geometry::ExtractedProfile;

use crate::rooms::floor_profiles;

/// How far a space may lean off vertical and still be emitted as a `Room2D`, as a
/// lateral-over-vertical ratio (a tangent): 0.035 is ~2°.
///
/// A Dragonfly `Room2D` is a floor polygon swept STRAIGHT UP. It cannot express a
/// ceiling laterally offset from its floor, nor a sloped floor plate. Emitting a
/// leaning prism as a vertical plate would silently ship wrong wall geometry — the
/// floor lands correctly and everything above it does not — so anything past this
/// threshold is counted as `skipped` instead, which is the same contract the
/// zero-height case already had.
///
/// The threshold is a ratio rather than an absolute distance so it is scale-free: a
/// 2° lean is 2° whether the room is 3 m or 30 m across. It sits ~5 orders of
/// magnitude above f32 round-off in `extrusion_dir` (which lands near 1e-7), so
/// nothing that is vertical in the file can trip it, while a genuinely tilted space
/// (~10 cm of ceiling drift over a 3 m storey) does.
const MAX_TILT_RATIO: f64 = 0.035;

/// True when `dir` is vertical to within [`MAX_TILT_RATIO`].
///
/// Compares the lateral component against the vertical one directly, so it holds
/// regardless of whether `dir` is unit-length.
fn is_vertical(dir: [f64; 3]) -> bool {
    let lateral = dir[0].hypot(dir[1]);
    let vertical = dir[2].abs();
    lateral <= MAX_TILT_RATIO * vertical
}

/// True when `ring` is horizontal to within [`MAX_TILT_RATIO`].
///
/// Measured as Z spread over the ring's horizontal diagonal, i.e. the same tangent
/// the extrusion test uses, so a large room with a millimetre of Z noise is accepted
/// while a genuinely sloped plate is not. A ring with no horizontal extent is
/// degenerate and reads as non-horizontal.
fn is_horizontal_ring(ring: &[[f64; 3]]) -> bool {
    let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
    for p in ring {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let span = (hi[0] - lo[0]).hypot(hi[1] - lo[1]);
    span > 0.0 && (hi[2] - lo[2]) <= MAX_TILT_RATIO * span
}

/// Intermediate per-space plate before story grouping.
pub(super) struct Plate {
    pub(super) express_id: u32,
    pub(super) boundary: Vec<[f64; 2]>,
    pub(super) floor_height: f64,
    pub(super) ftc_height: f64,
}

/// Extract one `Room2D` plate per `IfcSpace` from the shared floor profiles: the lower
/// (floor) ring projected to 2D, its Z as `floor_height`, and the extrusion magnitude as
/// `floor_to_ceiling_height`. Boundaries are normalised to counterclockwise.
pub(super) fn build_plates(profiles: &[ExtractedProfile], tol: f64) -> (Vec<Plate>, usize) {
    let (fps, _origin, mut skipped) = floor_profiles(profiles, tol);
    let mut plates = Vec::new();
    for fp in &fps {
        let floor = &fp.floor;
        // A `Room2D` is a floor polygon swept straight up, so a space that leans (an
        // oblique extrusion) or whose floor plate is sloped has no faithful
        // representation here. Reject both BEFORE building a plate: taking the lower
        // ring fixes where the floor lands but cannot recover the lateral offset of
        // everything above it, and projecting a sloped ring to 2D quietly shrinks its
        // area by cos(tilt) while `floor_height` averages the slope away. Counted as
        // `skipped`, so `stats.spaces == stats.rooms + stats.skipped` still holds.
        if !is_vertical(fp.dir) || !is_horizontal_ring(floor) {
            skipped += 1;
            continue;
        }
        // The floor ring is the lower of (ring, ring + dir*depth): pick whichever has the
        // smaller average Z so a downward extrusion still reads as floor-at-bottom.
        let avg_z = |r: &[[f64; 3]]| r.iter().map(|p| p[2]).sum::<f64>() / r.len().max(1) as f64;
        let floor_z = avg_z(floor);
        let ceil_z = floor_z + fp.dir[2] * fp.depth;
        // Take the boundary from whichever ring is actually the lower one. For a
        // downward extrusion that is the extruded ring, and an oblique `dir`
        // displaces it in XY as well as Z — so reading XY off the original ring
        // would place the plate correctly in Z but laterally offset by
        // `dir.xy * depth`. Vertical extrusions (the common case) are unaffected,
        // since their extruded ring has identical XY.
        let extruded: Vec<[f64; 3]> = floor
            .iter()
            .map(|p| {
                [
                    p[0] + fp.dir[0] * fp.depth,
                    p[1] + fp.dir[1] * fp.depth,
                    p[2] + fp.dir[2] * fp.depth,
                ]
            })
            .collect();
        let (lower_ring, lower, ftc) = if ceil_z >= floor_z {
            (floor.as_slice(), floor_z, ceil_z - floor_z)
        } else {
            // Downward extrusion: the "floor" is the lower ring (the extruded one).
            (extruded.as_slice(), ceil_z, floor_z - ceil_z)
        };
        if ftc <= tol {
            // Zero-height extrusion — not a usable room. Counted as skipped so
            // `stats.spaces == stats.rooms + stats.skipped` holds for callers
            // reporting coverage.
            skipped += 1;
            continue;
        }
        // Project to 2D and ensure counterclockwise winding (Dragonfly requirement).
        let mut boundary: Vec<[f64; 2]> = lower_ring.iter().map(|p| [p[0], p[1]]).collect();
        if signed_area_2d(&boundary) < 0.0 {
            boundary.reverse();
        }
        plates.push(Plate { express_id: fp.express_id, boundary, floor_height: lower, ftc_height: ftc });
    }
    (plates, skipped)
}

/// 2D signed area (positive = counterclockwise).
pub(super) fn signed_area_2d(b: &[[f64; 2]]) -> f64 {
    let n = b.len();
    let mut a = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        a += b[i][0] * b[j][1] - b[j][0] * b[i][1];
    }
    a * 0.5
}


/// Footprint signature used to spot duplicate spaces: floor centroid, plan area, and the
/// plate's Z extent.
struct Sig {
    cx: f64,
    cy: f64,
    area: f64,
    zmin: f64,
    zmax: f64,
}

fn plate_signature(p: &Plate) -> Option<Sig> {
    if p.boundary.is_empty() {
        return None;
    }
    let n = p.boundary.len() as f64;
    let cx = p.boundary.iter().map(|q| q[0]).sum::<f64>() / n;
    let cy = p.boundary.iter().map(|q| q[1]).sum::<f64>() / n;
    Some(Sig {
        cx,
        cy,
        area: signed_area_2d(&p.boundary).abs(),
        zmin: p.floor_height,
        zmax: p.floor_height + p.ftc_height,
    })
}

/// True when two plates are near-identical copies (the Revit duplicate-space artifact):
/// same floor centroid, same area, overlapping Z. Deliberately the SAME thresholds as
/// `rooms::is_duplicate`, so HBJSON and DFJSON drop the same duplicates rather than
/// disagreeing on room counts for the same file.
fn is_duplicate(a: &Sig, b: &Sig) -> bool {
    (a.cx - b.cx).abs() < 0.3
        && (a.cy - b.cy).abs() < 0.3
        && a.area > 0.0
        && (a.area - b.area).abs() / a.area.max(b.area) < 0.05
        && a.zmin < b.zmax
        && b.zmin < a.zmax
}

/// Keep the larger-area plate of each duplicate pair.
///
/// Without this, a model carrying duplicated `IfcSpace` geometry emits overlapping
/// `Room2D`s and the energy model double-counts their floor area — silently. HBJSON has
/// run the equivalent pass since it shipped (`rooms::dedupe_colliding`).
pub(super) fn dedupe_colliding(plates: Vec<Plate>) -> (Vec<Plate>, usize) {
    let sigs: Vec<Option<Sig>> = plates.iter().map(plate_signature).collect();
    let mut order: Vec<usize> = (0..plates.len()).collect();
    let area_of = |i: usize| sigs[i].as_ref().map_or(0.0, |s| s.area);
    order.sort_by(|&a, &b| area_of(b).partial_cmp(&area_of(a)).unwrap_or(std::cmp::Ordering::Equal));
    let mut keep = vec![false; plates.len()];
    let mut kept: Vec<usize> = Vec::new();
    for &i in &order {
        let dup = match &sigs[i] {
            Some(si) => kept.iter().any(|&j| sigs[j].as_ref().is_some_and(|sj| is_duplicate(si, sj))),
            None => false,
        };
        if !dup {
            keep[i] = true;
            kept.push(i);
        }
    }
    let dropped = keep.iter().filter(|k| !**k).count();
    let out = plates.into_iter().enumerate().filter(|(i, _)| keep[*i]).map(|(_, p)| p).collect();
    (out, dropped)
}
