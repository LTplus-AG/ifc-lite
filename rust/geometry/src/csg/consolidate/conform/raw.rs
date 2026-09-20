// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Seam conforming for plane buckets that bypass the planar union round-trip.

use super::{conform_ring, snap_near_duplicates, PlanBucket};
use nalgebra::{Point2, Point3};

/// Split singleton/fallback triangles at peer seam vertices.
///
/// Raw triangles are insertion sources in the seam map, but historically were
/// not insertion targets. A long raw edge opposite two shorter edges therefore
/// survived phase B as a T-junction. Work on a copy so a rejected conformed
/// candidate cannot alter the baseline output.
pub(super) fn conform_raw_triangles(plan: &mut PlanBucket, candidates: &[Point2<f64>]) -> bool {
    if plan.raw.is_empty() || candidates.is_empty() {
        return false;
    }

    let mut changed = false;
    let mut conformed = Vec::with_capacity(plan.raw.len());
    for tri in &plan.raw {
        let mut ring: Vec<Point2<f64>> = tri
            .iter()
            .map(|p| {
                let d = *p - plan.origin;
                Point2::new(d.dot(&plan.u_axis), d.dot(&plan.v_axis))
            })
            .collect();
        let mut triangle_changed =
            snap_near_duplicates(&mut ring, candidates, plan.origin, plan.u_axis, plan.v_axis);
        triangle_changed |= conform_ring(&mut ring, candidates);
        if !triangle_changed {
            conformed.push(*tri);
            continue;
        }

        changed = true;
        let lifted: Vec<Point3<f64>> = ring
            .iter()
            .map(|p| plan.origin + plan.u_axis * p.x + plan.v_axis * p.y)
            .collect();
        // Pick the boundary apex whose fan has the strongest weakest triangle.
        // With one split edge this is the untouched opposite corner, preserving
        // the old two-triangle topology while avoiding a collinear fan triangle.
        let mut best = (0, 0.0_f64);
        for apex in 0..lifted.len() {
            let mut min_area = f64::MAX;
            for offset in 1..lifted.len() - 1 {
                let edge_a = lifted[(apex + offset) % lifted.len()] - lifted[apex];
                let edge_b = lifted[(apex + offset + 1) % lifted.len()] - lifted[apex];
                min_area = min_area.min(edge_a.cross(&edge_b).norm_squared());
            }
            if min_area > best.1 {
                best = (apex, min_area);
            }
        }
        if best.1 > f64::EPSILON {
            for offset in 1..lifted.len() - 1 {
                conformed.push([
                    lifted[best.0],
                    lifted[(best.0 + offset) % lifted.len()],
                    lifted[(best.0 + offset + 1) % lifted.len()],
                ]);
            }
        } else {
            // Insertions on every side leave no non-collinear boundary apex.
            let centre = Point3::from((tri[0].coords + tri[1].coords + tri[2].coords) / 3.0);
            for i in 0..lifted.len() {
                conformed.push([centre, lifted[i], lifted[(i + 1) % lifted.len()]]);
            }
        }
    }

    if changed {
        plan.raw_conformed = Some(conformed);
    }
    changed
}
