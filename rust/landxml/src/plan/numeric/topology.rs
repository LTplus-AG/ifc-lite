/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;

pub(super) fn geometry_edges(
    geometry: &LandXmlPlanGeometry,
    start: LandXmlPlanPoint,
    end: LandXmlPlanPoint,
    chord: (LandXmlPlanPoint, LandXmlPlanPoint),
) -> Vec<(LandXmlPlanPoint, LandXmlPlanPoint)> {
    if geometry.kind == crate::LandXmlGeometryKind::Curve {
        // A chord is not the analytic curve. In particular, its endpoints
        // coincide with a legal closing line of a curved parcel, so it must
        // not participate in the line-segment retrace test.
        return Vec::new();
    }
    if geometry.kind != crate::LandXmlGeometryKind::IrregularLine {
        return vec![chord];
    }
    std::iter::once(start)
        .chain(geometry.intermediate_points.iter().copied())
        .chain(std::iter::once(end))
        .collect::<Vec<_>>()
        .windows(2)
        .map(|pair| (pair[0], pair[1]))
        .collect()
}

pub(super) fn segments_intersect(
    previous: &[(LandXmlPlanPoint, LandXmlPlanPoint)],
    segments: &[(LandXmlPlanPoint, LandXmlPlanPoint)],
    budget: &mut TopologyBudget<'_>,
) -> std::result::Result<bool, crate::LandXmlError> {
    for (index, left) in segments.iter().enumerate() {
        budget.check()?;
        if same_point(left.0, left.1) {
            return Ok(true);
        }
        for (other_index, right) in previous.iter().chain(segments.iter()).enumerate() {
            budget.check()?;
            let own_segment = other_index >= previous.len();
            let local_index = other_index.saturating_sub(previous.len());
            if own_segment && local_index == index {
                continue;
            }
            // Adjacent edges are not exempt as a pair: a two-line retrace
            // shares both endpoints and must be rejected. `intersects` only
            // accepts the one endpoint that adjoining legal edges share.
            if intersects(*left, *right) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub(super) fn intersects(
    (a, b): (LandXmlPlanPoint, LandXmlPlanPoint),
    (c, d): (LandXmlPlanPoint, LandXmlPlanPoint),
) -> bool {
    let shared = shared_endpoints((a, b), (c, d));
    if shared == 2 {
        return true;
    }
    if shared == 1 {
        return overlaps_beyond_shared_endpoint((a, b), (c, d));
    }
    let orientation = |p: LandXmlPlanPoint, q: LandXmlPlanPoint, r: LandXmlPlanPoint| {
        (q.northing - p.northing) * (r.easting - p.easting)
            - (q.easting - p.easting) * (r.northing - p.northing)
    };
    let ab_c = orientation(a, b, c);
    let ab_d = orientation(a, b, d);
    let cd_a = orientation(c, d, a);
    let cd_b = orientation(c, d, b);
    if ab_c.is_finite()
        && ab_d.is_finite()
        && cd_a.is_finite()
        && cd_b.is_finite()
        && ab_c * ab_d < -EPSILON
        && cd_a * cd_b < -EPSILON
    {
        return true;
    }
    (ab_c.abs() <= EPSILON && on_segment(a, c, b))
        || (ab_d.abs() <= EPSILON && on_segment(a, d, b))
        || (cd_a.abs() <= EPSILON && on_segment(c, a, d))
        || (cd_b.abs() <= EPSILON && on_segment(c, b, d))
}

fn shared_endpoints(
    (a, b): (LandXmlPlanPoint, LandXmlPlanPoint),
    (c, d): (LandXmlPlanPoint, LandXmlPlanPoint),
) -> usize {
    usize::from(same_point(a, c))
        + usize::from(same_point(a, d))
        + usize::from(same_point(b, c))
        + usize::from(same_point(b, d))
}

/// A pair of non-zero segments is allowed to meet at one endpoint only. When
/// they are collinear and point into the same ray they overlap beyond that
/// endpoint, which is a retrace rather than a legal polygon vertex.
fn overlaps_beyond_shared_endpoint(
    (a, b): (LandXmlPlanPoint, LandXmlPlanPoint),
    (c, d): (LandXmlPlanPoint, LandXmlPlanPoint),
) -> bool {
    let (shared, left, right) = if same_point(a, c) {
        (a, b, d)
    } else if same_point(a, d) {
        (a, b, c)
    } else if same_point(b, c) {
        (b, a, d)
    } else {
        (b, a, c)
    };
    let left_northing = left.northing - shared.northing;
    let left_easting = left.easting - shared.easting;
    let right_northing = right.northing - shared.northing;
    let right_easting = right.easting - shared.easting;
    let cross = left_northing * right_easting - left_easting * right_northing;
    let dot = left_northing * right_northing + left_easting * right_easting;
    cross.is_finite() && dot.is_finite() && cross.abs() <= EPSILON && dot > EPSILON
}

pub(super) fn on_segment(
    start: LandXmlPlanPoint,
    point: LandXmlPlanPoint,
    end: LandXmlPlanPoint,
) -> bool {
    point.northing >= start.northing.min(end.northing) - EPSILON
        && point.northing <= start.northing.max(end.northing) + EPSILON
        && point.easting >= start.easting.min(end.easting) - EPSILON
        && point.easting <= start.easting.max(end.easting) + EPSILON
}
