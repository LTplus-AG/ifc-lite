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
use crate::triangulation::project_to_2d_with_basis;
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;
use nalgebra::Vector3;

mod disjoint;

pub(super) struct RetryGeometry {
    subject: Vec<Vec<[f64; 2]>>,
    clip: Vec<Vec<[f64; 2]>>,
    plane_area: f64,
}

/// Produce the established union first. Retain existing operand buffers only
/// for an untagged, noncoplanar bucket with multiple union regions.
pub(super) fn append_baseline_plan(
    tris: &[PlaneTri],
    use_tag: bool,
    next_bid: &mut u32,
    length_unit_scale: f64,
    plans: &mut Vec<PlanBucket>,
) {
    let plan = plan_one(tris, use_tag, *next_bid, length_unit_scale, None);
    *next_bid += 1;
    plans.push(plan);
}

pub(super) fn append_prepared_retry(
    tris: &[PlaneTri],
    baseline: &mut PlanBucket,
    next_bid: &mut u32,
    length_unit_scale: f64,
    plans: &mut Vec<PlanBucket>,
) -> bool {
    let Some(retry) = baseline.retry.take() else {
        return false;
    };
    let Some(groups) = certified_groups(tris, &retry.subject, &retry.clip) else {
        return false;
    };
    append_groups(
        tris,
        groups,
        false,
        baseline.bid,
        next_bid,
        length_unit_scale,
        retry.plane_area,
        plans,
    );
    true
}

fn append_groups(
    tris: &[PlaneTri],
    groups: Vec<Vec<usize>>,
    use_tag: bool,
    source_bid: u32,
    next_bid: &mut u32,
    length_unit_scale: f64,
    noise_area: f64,
    plans: &mut Vec<PlanBucket>,
) {
    for group in groups {
        // Groups are ordered by first member, so exactly one starts at the
        // bucket's first triangle and plans in the bucket's established frame.
        // It keeps the replaced plan's id, by which the failed-conform
        // source-boundary retry finds that frame (#7638 review). Every other
        // group takes a fresh id, so seam ownership stays unique.
        let bid = if group[0] == 0 {
            source_bid
        } else {
            let fresh = *next_bid;
            *next_bid += 1;
            fresh
        };
        // The common single-region path copies no source triangles
        // and allocates no temporary output Vec. On this retry every
        // triangle belongs to exactly one group.
        let own: Vec<_> = group.into_iter().map(|i| tris[i].clone()).collect();
        let plan = plan_one(&own, use_tag, bid, length_unit_scale, Some(noise_area));
        plans.push(plan);
    }
}

fn plan_one(
    tris: &[PlaneTri],
    use_tag: bool,
    bid: u32,
    length_unit_scale: f64,
    original_noise_area: Option<f64>,
) -> PlanBucket {
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
        retry: None,
    };
    // Retry singleton groups still pass through the union/ring noise checks
    // used by their original multi-triangle bucket.
    if tris.len() == 1 && original_noise_area.is_none() {
        plan.raw.push(tris[0].v);
        return plan;
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
        return plan;
    }
    let retry_possible = !use_tag && shapes.len() > 1 && !exactly_coplanar(tris);
    // Regrouping must not change the existing ring-noise share threshold.
    let plane_area = original_noise_area.unwrap_or(plane_area);
    // Preserve main's context-aware contour topology guard for every ordinary/retry plan.
    plan.regions = PlanRegion::from_shapes(&shapes, plane_area, length_unit_scale);
    if original_noise_area.is_none() && retry_possible {
        plan.retry = Some(RetryGeometry {
            subject,
            clip,
            plane_area,
        });
    }
    plan
}

fn certified_groups(
    tris: &[PlaneTri],
    subject: &[Vec<[f64; 2]>],
    clip: &[Vec<[f64; 2]>],
) -> Option<Vec<Vec<usize>>> {
    let groups = disjoint::separated_groups(subject, clip)?;
    // A quantized key does not certify even a local source group. Tagged
    // buckets are excluded separately: a tolerance-supported tag can tilt
    // relative to the exact source plane.
    groups
        .iter()
        .all(|group| coplanar_with_first(&tris[group[0]], group[1..].iter().map(|&i| &tris[i])))
        .then_some(groups)
}

/// A genuinely common source plane has no remote-plane projection defect.
/// Preserve its established union rounding, cleanup and output ordering. The
/// exact predicate adds no geometric tolerance, and runs only after the
/// existing union has produced multiple regions.
fn exactly_coplanar(tris: &[PlaneTri]) -> bool {
    coplanar_with_first(&tris[0], tris[1..].iter())
}

fn coplanar_with_first<'a>(first: &PlaneTri, rest: impl Iterator<Item = &'a PlaneTri>) -> bool {
    let [a, b, c] = first.v.map(|p| [p.x, p.y, p.z]);
    rest.flat_map(|t| t.v)
        .all(|p| geometry_predicates::orient3d(a, b, c, [p.x, p.y, p.z]) == 0.0)
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
