// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Plane-bucket union and ring planning, including remote-plane isolation.
//!
//! A quantized plane key is not an exact common plane. Two remote wall patches
//! can have almost equal f32-derived normals and the same rounded offset, yet
//! projecting both onto the first patch's plane moves the distant boundary by
//! tens of micrometres (#7633, found while investigating #6940). Its adjacent faces retain
//! the original boundary, leaving a crack.
//!
//! Only a multi-region union of noncoplanar source triangles with a strict gap
//! between its input triangles'
//! PROJECTED axis intervals retries. The gap proves these groups do not interact
//! in the existing 2D union, including point contacts and crossing triangles.
//! Each group then uses its own first source triangle's plane. Exactly one
//! regroup/re-union is allowed; the existing behavior within a group is intact.
//! Interlocking disjoint regions whose intervals overlap remain unchanged: this
//! is a narrow recovery, not a general partition into connected components.

use super::conform::{PlanBucket, PlanRegion};
use super::plane_merge::PlaneTri;
use super::ring_ops::clean_ring;
use crate::triangulation::project_to_2d_with_basis;
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;
use nalgebra::Vector3;

mod disjoint;

enum Planned {
    Ready(PlanBucket),
    Separate(Vec<Vec<usize>>, f64),
}

pub(super) fn append_bucket_plans(
    tris: &[PlaneTri],
    use_tag: bool,
    next_bid: &mut u32,
    length_unit_scale: f64,
    plans: &mut Vec<PlanBucket>,
) {
    if tris.is_empty() {
        return;
    }
    match plan_one(tris, use_tag, *next_bid, length_unit_scale, true, None) {
        Planned::Ready(plan) => {
            *next_bid += 1;
            plans.push(plan);
        }
        Planned::Separate(groups, noise_area) => {
            for group in groups {
                // The common single-region path copies no source triangles
                // and allocates no temporary output Vec. On this retry every
                // triangle belongs to exactly one group.
                let own: Vec<_> = group.into_iter().map(|i| tris[i].clone()).collect();
                let Planned::Ready(plan) = plan_one(
                    &own,
                    use_tag,
                    *next_bid,
                    length_unit_scale,
                    false,
                    Some(noise_area),
                ) else {
                    unreachable!("the single regroup retry cannot partition again")
                };
                *next_bid += 1;
                plans.push(plan);
            }
        }
    }
}

fn plan_one(
    tris: &[PlaneTri],
    use_tag: bool,
    bid: u32,
    length_unit_scale: f64,
    allow_partition: bool,
    original_noise_area: Option<f64>,
) -> Planned {
    crate::progress::tick();
    // #3914: only a bucket merged using trusted kernel plane tags uses its tag.
    // Separated groups retain this policy: a merged bucket still uses its tag;
    // an ordinary bucket uses each group's first source normal.
    let normal = if use_tag {
        tris[0].tag.map(|(n, _)| n).unwrap_or(tris[0].normal)
    } else {
        tris[0].normal
    };
    let origin = tris[0].v[0];
    let abs = (normal.x.abs(), normal.y.abs(), normal.z.abs());
    let reference = if abs.0 <= abs.1 && abs.0 <= abs.2 {
        Vector3::new(1.0, 0.0, 0.0)
    } else if abs.1 <= abs.2 {
        Vector3::new(0.0, 1.0, 0.0)
    } else {
        Vector3::new(0.0, 0.0, 1.0)
    };
    let u_axis = normal.cross(&reference).normalize();
    let v_axis = normal.cross(&u_axis).normalize();
    let mut plan = PlanBucket {
        bid,
        normal,
        origin,
        u_axis,
        v_axis,
        raw: Vec::new(),
        raw_conformed: None,
        regions: Vec::new(),
    };
    // Retry singleton groups still pass through the union/ring noise checks
    // used by their original multi-triangle bucket.
    if tris.len() == 1 && original_noise_area.is_none() {
        plan.raw.push(tris[0].v);
        return Planned::Ready(plan);
    }
    let mut subject: Vec<Vec<[f64; 2]>> = Vec::with_capacity(1);
    let mut clip: Vec<Vec<[f64; 2]>> = Vec::with_capacity(tris.len() - 1);
    let mut plane_area = 0.0_f64;
    for (idx, tri) in tris.iter().enumerate() {
        let pts_2d = project_to_2d_with_basis(&tri.v, &u_axis, &v_axis, &origin);
        // Preserve the established NonZero union: all projected triangles CCW.
        let signed_area = (pts_2d[1].x - pts_2d[0].x) * (pts_2d[2].y - pts_2d[0].y)
            - (pts_2d[1].y - pts_2d[0].y) * (pts_2d[2].x - pts_2d[0].x);
        plane_area += 0.5 * signed_area.abs();
        let path = if signed_area >= 0.0 {
            pts_2d.iter().map(|p| [p.x, p.y]).collect()
        } else {
            pts_2d.iter().rev().map(|p| [p.x, p.y]).collect()
        };
        if idx == 0 {
            subject.push(path);
        } else {
            clip.push(path);
        }
    }
    let shapes = subject.overlay(&clip, OverlayRule::Union, FillRule::NonZero);
    if shapes.is_empty() {
        plan.raw.extend(tris.iter().map(|t| t.v));
        return Planned::Ready(plan);
    }
    if allow_partition && shapes.len() > 1 && !exactly_coplanar(tris) {
        if let Some(groups) = disjoint::separated_groups(&subject, &clip) {
            return Planned::Separate(groups, plane_area);
        }
    }
    // Regrouping must not change the existing ring-noise share threshold.
    let plane_area = original_noise_area.unwrap_or(plane_area);
    for shape in shapes {
        let Some(outer) = shape
            .first()
            .and_then(|c| clean_ring(c, plane_area, length_unit_scale))
        else {
            continue;
        };
        let holes: Vec<_> = shape[1..]
            .iter()
            .filter_map(|c| clean_ring(c, plane_area, length_unit_scale))
            .collect();
        plan.regions.push(PlanRegion {
            changed: false,
            cached: None,
            outer_conformed: outer.clone(),
            holes_conformed: holes.clone(),
            outer,
            holes,
        });
    }
    Planned::Ready(plan)
}

/// A genuinely common source plane has no remote-plane projection defect.
/// Preserve its established union rounding, cleanup and output ordering. The
/// exact predicate adds no geometric tolerance, and runs only after the
/// existing union has produced multiple regions.
fn exactly_coplanar(tris: &[PlaneTri]) -> bool {
    let [a, b, c] = tris[0].v.map(|p| [p.x, p.y, p.z]);
    tris[1..]
        .iter()
        .flat_map(|t| t.v)
        .all(|p| geometry_predicates::orient3d(a, b, c, [p.x, p.y, p.z]) == 0.0)
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
