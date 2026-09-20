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
            if own_segment
                && (local_index == index
                    || local_index.abs_diff(index) == 1
                    || (index == 0 && local_index + 1 == segments.len())
                    || (local_index == 0 && index + 1 == segments.len()))
            {
                continue;
            }
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
    let orientation = |p: LandXmlPlanPoint, q: LandXmlPlanPoint, r: LandXmlPlanPoint| {
        (q.northing - p.northing) * (r.easting - p.easting)
            - (q.easting - p.easting) * (r.northing - p.northing)
    };
    let ab_c = orientation(a, b, c);
    let ab_d = orientation(a, b, d);
    let cd_a = orientation(c, d, a);
    let cd_b = orientation(c, d, b);
    if ab_c * ab_d < -EPSILON && cd_a * cd_b < -EPSILON {
        return true;
    }
    (ab_c.abs() <= EPSILON && on_segment(a, c, b))
        || (ab_d.abs() <= EPSILON && on_segment(a, d, b))
        || (cd_a.abs() <= EPSILON && on_segment(c, a, d))
        || (cd_b.abs() <= EPSILON && on_segment(c, b, d))
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
