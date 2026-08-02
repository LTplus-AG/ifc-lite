//! Per-space plate extraction: one floor ring + heights per `IfcSpace`.

use ifc_lite_geometry::ExtractedProfile;

use crate::rooms::floor_profiles;

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

