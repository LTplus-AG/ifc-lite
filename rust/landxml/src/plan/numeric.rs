/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::{
    LandXmlParcel, LandXmlParcelProbe, LandXmlParcelState, LandXmlPlanDocument,
    LandXmlPlanGeometry, LandXmlPlanPoint, LandXmlPlanPointLocation,
};
use std::collections::{HashMap, HashSet};

mod topology;
use topology::{geometry_edges, segments_intersect};

const EPSILON: f64 = 1e-9;

pub(super) struct TopologyBudget<'a> {
    pub(super) work: usize,
    pub(super) max_work: usize,
    pub(super) cancelled: Option<&'a dyn crate::LandXmlCancellation>,
}
impl TopologyBudget<'_> {
    pub(super) fn check(&mut self) -> std::result::Result<(), crate::LandXmlError> {
        if self
            .cancelled
            .is_some_and(crate::LandXmlCancellation::is_cancelled)
        {
            return Err(crate::LandXmlError::new(
                crate::LandXmlDiagnosticCode::Cancelled,
                "parcel probe cancelled",
            ));
        }
        self.work = self.work.checked_add(1).ok_or_else(|| {
            crate::LandXmlError::new(
                crate::LandXmlDiagnosticCode::LimitExceeded,
                "parcel topology work limit exceeded",
            )
        })?;
        if self.work > self.max_work {
            return Err(crate::LandXmlError::new(
                crate::LandXmlDiagnosticCode::LimitExceeded,
                "parcel topology work limit exceeded",
            ));
        }
        Ok(())
    }
}

impl LandXmlPlanDocument {
    /// Partition plan-source identities without coupling semantic records to a
    /// renderer allocation or introducing a second model-load path.
    pub fn source_batches(&self, max_records: usize) -> Vec<super::LandXmlPlanSourceBatch> {
        if max_records == 0 {
            return Vec::new();
        }
        let source_ids = self
            .cogo_points
            .iter()
            .map(|point| point.source_id.clone())
            .chain(
                self.monuments
                    .iter()
                    .map(|monument| monument.source_id.clone()),
            )
            .chain(self.plan_features.iter().flat_map(|feature| {
                std::iter::once(feature.source_id.clone()).chain(
                    feature
                        .geometry
                        .iter()
                        .map(|geometry| geometry.source_id.clone()),
                )
            }))
            .chain(self.parcels.iter().flat_map(|parcel| {
                std::iter::once(parcel.source_id.clone()).chain(
                    parcel
                        .loops
                        .iter()
                        .flatten()
                        .map(|geometry| geometry.source_id.clone()),
                )
            }));
        let mut batches = Vec::new();
        let mut current = Vec::with_capacity(max_records);
        for source_id in source_ids {
            current.push(source_id);
            if current.len() == max_records {
                batches.push(super::LandXmlPlanSourceBatch {
                    source_ids: current,
                });
                current = Vec::with_capacity(max_records);
            }
        }
        if !current.is_empty() {
            batches.push(super::LandXmlPlanSourceBatch {
                source_ids: current,
            });
        }
        batches
    }
    /// Resolve a COGO reference in its producer scope, falling back only when
    /// the document has one unambiguous name match.
    pub fn resolve_point(
        &self,
        scope_id: Option<&crate::LandXmlSourceId>,
        location: &LandXmlPlanPointLocation,
    ) -> Option<LandXmlPlanPoint> {
        match location {
            LandXmlPlanPointLocation::Coordinates { point, .. } => Some(*point),
            LandXmlPlanPointLocation::PointReference { pnt_ref } => {
                self.resolve_reference(scope_id, pnt_ref, self.cogo_points.len())
            }
        }
    }

    fn resolve_reference(
        &self,
        scope_id: Option<&crate::LandXmlSourceId>,
        reference: &str,
        budget: usize,
    ) -> Option<LandXmlPlanPoint> {
        let mut scoped: HashMap<(crate::LandXmlSourceId, String), Option<usize>> = HashMap::new();
        let mut global: HashMap<String, Option<usize>> = HashMap::new();
        for (index, point) in self.cogo_points.iter().enumerate() {
            let mut keys = vec![point.ordinal.to_string(), point.source_id.0.clone()];
            if let Some(name) = &point.name {
                keys.push(name.clone());
            }
            if let Some(oid) = point.properties.get("oID") {
                keys.push(oid.clone());
            }
            keys.sort();
            keys.dedup();
            for key in keys {
                scoped
                    .entry((point.scope_id.clone(), key.clone()))
                    .and_modify(|slot| *slot = None)
                    .or_insert(Some(index));
                global
                    .entry(key)
                    .and_modify(|slot| *slot = None)
                    .or_insert(Some(index));
            }
        }
        let mut next_scope = scope_id.cloned();
        let mut next_reference = reference;
        let mut remaining = budget;
        let mut seen = HashSet::new();
        while remaining > 0 {
            let index = match &next_scope {
                Some(scope) => *scoped.get(&(scope.clone(), next_reference.to_owned()))?,
                None => *global.get(next_reference)?,
            }?;
            if !seen.insert(index) {
                return None;
            }
            let point = &self.cogo_points[index];
            if let Some(value) = point.point {
                return Some(value);
            }
            next_scope = Some(point.scope_id.clone());
            next_reference = point.pnt_ref.as_deref()?;
            remaining -= 1;
        }
        None
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

    /// Probe a parcel in authored units with the default topology work bound.
    pub fn probe_parcel(&self, parcel: &LandXmlParcel) -> LandXmlParcelProbe {
        self.probe_parcel_with_cancel(parcel, 1_000_000, None)
            .unwrap_or_else(|error| preserved(parcel, &error.message))
    }

    /// Probe a parcel while polling cancellation inside pairwise topology work.
    pub fn probe_parcel_with_cancel(
        &self,
        parcel: &LandXmlParcel,
        max_topology_work: usize,
        cancelled: Option<&dyn crate::LandXmlCancellation>,
    ) -> std::result::Result<LandXmlParcelProbe, crate::LandXmlError> {
        let mut budget = TopologyBudget {
            work: 0,
            max_work: max_topology_work,
            cancelled,
        };
        if let Some(reason) = &parcel.preservation_reason {
            return Ok(preserved(parcel, reason));
        }
        let mut perimeter = 0.0;
        let mut twice_area = 0.0;
        let mut all_segments = Vec::new();
        for loop_geometry in &parcel.loops {
            let Some(loop_probe) = probe_loop(self, loop_geometry, &mut budget)? else {
                return Ok(preserved(parcel, "open or unresolved boundary"));
            };
            if loop_probe.self_intersects {
                return Ok(preserved(parcel, "self-intersecting boundary"));
            }
            perimeter += loop_probe.perimeter;
            twice_area += loop_probe.twice_area;
            if segments_intersect(&all_segments, &loop_probe.segments, &mut budget)? {
                return Ok(preserved(parcel, "cross-loop or retraced boundary"));
            }
            all_segments.extend(loop_probe.segments);
        }
        if parcel.loops.is_empty() {
            return Ok(preserved(parcel, "missing CoordGeom boundary"));
        }
        let area = twice_area.abs() * 0.5;
        Ok(LandXmlParcelProbe {
            state: LandXmlParcelState::Analytic,
            perimeter_in_declared_linear_units: Some(perimeter),
            area_in_declared_square_units: Some(area),
            declared_area: parcel.declared_area,
            declared_perimeter: parcel.declared_perimeter,
            perimeter_in_meters: self
                .units
                .as_ref()
                .map(|units| perimeter * units.linear_scale_to_meters),
            area_in_square_meters: self
                .units
                .as_ref()
                .map(|units| area * units.linear_scale_to_meters.powi(2)),
        })
    }
}

struct LoopProbe {
    perimeter: f64,
    twice_area: f64,
    self_intersects: bool,
    segments: Vec<(LandXmlPlanPoint, LandXmlPlanPoint)>,
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
        perimeter_in_meters: None,
        area_in_square_meters: None,
    }
}

fn probe_loop(
    document: &LandXmlPlanDocument,
    geometry: &[LandXmlPlanGeometry],
    budget: &mut TopologyBudget<'_>,
) -> std::result::Result<Option<LoopProbe>, crate::LandXmlError> {
    // A full curve/curve intersection solver belongs in the future renderer
    // adapter. Until then, only a single analytic arc plus its closing chord
    // receives a fill-capable probe; richer curved loops stay preserved-only.
    let curve_count = geometry
        .iter()
        .filter(|item| item.kind == super::LandXmlGeometryKind::Curve)
        .count();
    if curve_count > 1 || (curve_count == 1 && geometry.len() > 2) {
        return Ok(None);
    }
    let mut segments = Vec::with_capacity(geometry.len());
    let mut perimeter = 0.0;
    let mut twice_area = 0.0;
    let mut previous_end = None;
    for item in geometry {
        budget.check()?;
        let Some(start) = document.resolve_point(item.point_scope_id.as_ref(), &item.start) else {
            return Ok(None);
        };
        let Some(end) = document.resolve_point(item.point_scope_id.as_ref(), &item.end) else {
            return Ok(None);
        };
        if previous_end.is_some_and(|previous| !same_point(previous, start)) {
            return Ok(None);
        }
        let Some((length, integral, chord)) = geometry_measure(document, item, start, end) else {
            return Ok(None);
        };
        perimeter += length;
        twice_area += integral;
        segments.extend(geometry_edges(item, start, end, chord));
        previous_end = Some(end);
    }
    let (Some(first), Some(last)) = (
        geometry
            .first()
            .and_then(|item| document.resolve_point(item.point_scope_id.as_ref(), &item.start)),
        previous_end,
    ) else {
        return Ok(None);
    };
    if !same_point(first, last) {
        return Ok(None);
    }
    Ok(Some(LoopProbe {
        perimeter,
        twice_area,
        self_intersects: segments_intersect(&[], &segments, budget)?,
        segments,
    }))
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
                (start.northing - center.northing).atan2(start.easting - center.easting);
            let end_angle = (end.northing - center.northing).atan2(end.easting - center.easting);
            let delta = arc_delta(
                start_angle,
                end_angle,
                geometry.rotation.as_deref(),
                geometry.declared_length,
                radius,
            )?;
            let integral = center.easting * (end.northing - start.northing)
                - center.northing * (end.easting - start.easting)
                + radius * radius * delta;
            Some((radius * delta.abs(), integral, (start, end)))
        }
    }
}

fn arc_delta(
    start: f64,
    end: f64,
    rotation: Option<&str>,
    declared_length: Option<f64>,
    radius: f64,
) -> Option<f64> {
    let tau = std::f64::consts::TAU;
    let primary = match rotation {
        Some("ccw") => Some((end - start).rem_euclid(tau)),
        Some("cw") => Some(-((start - end).rem_euclid(tau))),
        _ => None,
    };
    let primary = primary?;
    if let Some(length) = declared_length {
        let tolerance = EPSILON * radius.max(length).max(1.0);
        if (radius * primary.abs() - length).abs() > tolerance {
            return None;
        }
    }
    Some(primary)
}

fn same_point(left: LandXmlPlanPoint, right: LandXmlPlanPoint) -> bool {
    distance(left, right) <= EPSILON
}
fn distance(left: LandXmlPlanPoint, right: LandXmlPlanPoint) -> f64 {
    (left.northing - right.northing).hypot(left.easting - right.easting)
}
fn cross(left: LandXmlPlanPoint, right: LandXmlPlanPoint) -> f64 {
    left.easting * right.northing - left.northing * right.easting
}
