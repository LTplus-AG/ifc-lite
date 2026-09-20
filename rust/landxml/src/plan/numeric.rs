/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::{
    LandXmlParcel, LandXmlParcelProbe, LandXmlParcelState, LandXmlPlanDocument,
    LandXmlPlanGeometry, LandXmlPlanPoint, LandXmlPlanPointLocation,
};

const EPSILON: f64 = 1e-9;

impl LandXmlPlanDocument {
    /// Resolve a COGO reference in its producer scope, falling back only when
    /// the document has one unambiguous name match.
    pub fn resolve_point(
        &self,
        scope_id: Option<&crate::LandXmlSourceId>,
        location: &LandXmlPlanPointLocation,
    ) -> Option<LandXmlPlanPoint> {
        match location {
            LandXmlPlanPointLocation::Coordinates { point } => Some(*point),
            LandXmlPlanPointLocation::PointReference { pnt_ref } => {
                let scoped = self.cogo_points.iter().filter(|point| {
                    scope_id.is_some_and(|scope| point.scope_id == *scope)
                        && point.name.as_deref() == Some(pnt_ref)
                });
                let mut scoped = scoped.map(|point| point.point);
                if let Some(point) = scoped.next() {
                    return scoped.next().is_none().then_some(point);
                }
                let mut points = self
                    .cogo_points
                    .iter()
                    .filter(|point| point.name.as_deref() == Some(pnt_ref))
                    .map(|point| point.point);
                let point = points.next()?;
                points.next().is_none().then_some(point)
            }
        }
    }

    /// Resolve a monument's direct coordinate or its scoped `pntRef`.
    pub fn resolve_monument_point(
        &self,
        monument: &super::LandXmlMonument,
    ) -> Option<LandXmlPlanPoint> {
        monument.point.or_else(|| {
            monument.pnt_ref.as_ref().and_then(|pnt_ref| {
                self.resolve_point(
                    monument.point_scope_id.as_ref(),
                    &LandXmlPlanPointLocation::PointReference {
                        pnt_ref: pnt_ref.clone(),
                    },
                )
            })
        })
    }

    /// Probe a parcel in authored units. Invalid, open, self-intersecting and
    /// unresolved loops remain source records and receive no invented fill.
    pub fn probe_parcel(&self, parcel: &LandXmlParcel) -> LandXmlParcelProbe {
        let mut perimeter = 0.0;
        let mut twice_area = 0.0;
        for loop_geometry in &parcel.loops {
            let Some(loop_probe) = probe_loop(self, loop_geometry) else {
                return preserved(parcel, "open or unresolved boundary");
            };
            if loop_probe.self_intersects {
                return preserved(parcel, "self-intersecting boundary");
            }
            perimeter += loop_probe.perimeter;
            twice_area += loop_probe.twice_area;
        }
        if parcel.loops.is_empty() {
            return preserved(parcel, "missing CoordGeom boundary");
        }
        LandXmlParcelProbe {
            state: LandXmlParcelState::Analytic,
            perimeter_in_declared_linear_units: Some(perimeter),
            area_in_declared_square_units: Some(twice_area.abs() * 0.5),
            declared_area: parcel.declared_area,
            declared_perimeter: parcel.declared_perimeter,
        }
    }
}

struct LoopProbe {
    perimeter: f64,
    twice_area: f64,
    self_intersects: bool,
}

fn preserved(parcel: &LandXmlParcel, reason: &str) -> LandXmlParcelProbe {
    LandXmlParcelProbe {
        state: LandXmlParcelState::PreservedOnly {
            reason: reason.to_owned(),
        },
        perimeter_in_declared_linear_units: None,
        area_in_declared_square_units: None,
        declared_area: parcel.declared_area,
        declared_perimeter: parcel.declared_perimeter,
    }
}

fn probe_loop(
    document: &LandXmlPlanDocument,
    geometry: &[LandXmlPlanGeometry],
) -> Option<LoopProbe> {
    // A full curve/curve intersection solver belongs in the future renderer
    // adapter. Until then, only a single analytic arc plus its closing chord
    // receives a fill-capable probe; richer curved loops stay preserved-only.
    if geometry.len() > 2
        && geometry
            .iter()
            .any(|item| item.kind == super::LandXmlGeometryKind::Curve)
    {
        return None;
    }
    let mut segments = Vec::with_capacity(geometry.len());
    let mut perimeter = 0.0;
    let mut twice_area = 0.0;
    let mut previous_end = None;
    for item in geometry {
        let start = document.resolve_point(item.point_scope_id.as_ref(), &item.start)?;
        let end = document.resolve_point(item.point_scope_id.as_ref(), &item.end)?;
        if previous_end.is_some_and(|previous| !same_point(previous, start)) {
            return None;
        }
        let (length, integral, chord) = geometry_measure(document, item, start, end)?;
        perimeter += length;
        twice_area += integral;
        segments.push(chord);
        previous_end = Some(end);
    }
    let (Some(first), Some(last)) = (
        geometry
            .first()
            .and_then(|item| document.resolve_point(item.point_scope_id.as_ref(), &item.start)),
        previous_end,
    ) else {
        return None;
    };
    if !same_point(first, last) {
        return None;
    }
    Some(LoopProbe {
        perimeter,
        twice_area,
        self_intersects: segments_intersect(&segments),
    })
}

fn geometry_measure(
    document: &LandXmlPlanDocument,
    geometry: &LandXmlPlanGeometry,
    start: LandXmlPlanPoint,
    end: LandXmlPlanPoint,
) -> Option<(f64, f64, (LandXmlPlanPoint, LandXmlPlanPoint))> {
    match geometry.kind {
        super::LandXmlGeometryKind::Line => {
            Some((distance(start, end), cross(start, end), (start, end)))
        }
        super::LandXmlGeometryKind::IrregularLine => {
            let mut points = Vec::with_capacity(geometry.intermediate_points.len() + 2);
            points.push(start);
            points.extend(geometry.intermediate_points.iter().copied());
            points.push(end);
            let (length, integral) =
                points
                    .windows(2)
                    .fold((0.0, 0.0), |(length, integral), pair| {
                        (
                            length + distance(pair[0], pair[1]),
                            integral + cross(pair[0], pair[1]),
                        )
                    });
            Some((length, integral, (start, end)))
        }
        super::LandXmlGeometryKind::Curve => {
            let center = document
                .resolve_point(geometry.point_scope_id.as_ref(), geometry.center.as_ref()?)?;
            let radius = geometry.radius.unwrap_or_else(|| distance(center, start));
            if radius <= 0.0
                || (distance(center, start) - radius).abs() > EPSILON
                || (distance(center, end) - radius).abs() > EPSILON
            {
                return None;
            }
            let start_angle =
                (start.easting - center.easting).atan2(start.northing - center.northing);
            let end_angle = (end.easting - center.easting).atan2(end.northing - center.northing);
            let delta = arc_delta(start_angle, end_angle, geometry.rotation.as_deref())?;
            let integral = center.northing * (end.easting - start.easting)
                - center.easting * (end.northing - start.northing)
                + radius * radius * delta;
            Some((radius * delta.abs(), integral, (start, end)))
        }
    }
}

fn arc_delta(start: f64, end: f64, rotation: Option<&str>) -> Option<f64> {
    let tau = std::f64::consts::TAU;
    match rotation {
        Some("ccw") => Some((end - start).rem_euclid(tau)),
        Some("cw") => Some(-((start - end).rem_euclid(tau))),
        _ => None,
    }
}

fn same_point(left: LandXmlPlanPoint, right: LandXmlPlanPoint) -> bool {
    distance(left, right) <= EPSILON
}
fn distance(left: LandXmlPlanPoint, right: LandXmlPlanPoint) -> f64 {
    (left.northing - right.northing).hypot(left.easting - right.easting)
}
fn cross(left: LandXmlPlanPoint, right: LandXmlPlanPoint) -> f64 {
    left.northing * right.easting - left.easting * right.northing
}

fn segments_intersect(segments: &[(LandXmlPlanPoint, LandXmlPlanPoint)]) -> bool {
    for (index, left) in segments.iter().enumerate() {
        for (other_index, right) in segments.iter().enumerate().skip(index + 1) {
            if other_index == index + 1 || (index == 0 && other_index + 1 == segments.len()) {
                continue;
            }
            if intersects(*left, *right) {
                return true;
            }
        }
    }
    false
}

fn intersects(
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

fn on_segment(start: LandXmlPlanPoint, point: LandXmlPlanPoint, end: LandXmlPlanPoint) -> bool {
    point.northing >= start.northing.min(end.northing) - EPSILON
        && point.northing <= start.northing.max(end.northing) + EPSILON
        && point.easting >= start.easting.min(end.easting) - EPSILON
        && point.easting <= start.easting.max(end.easting) + EPSILON
}
