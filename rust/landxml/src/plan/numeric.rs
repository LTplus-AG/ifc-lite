/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::{
    LandXmlParcel, LandXmlParcelProbe, LandXmlParcelState, LandXmlPlanDocument,
    LandXmlPlanGeometry, LandXmlPlanPoint, LandXmlPlanPointLocation,
};

mod measure;
pub mod references;
mod topology;
use measure::{arc_delta, cross, distance, finite_measure, finite_point, finite_sum, same_point};
use topology::segments_intersect;

const EPSILON: f64 = 1e-9;
type GeometryMeasure = (f64, f64, Vec<(LandXmlPlanPoint, LandXmlPlanPoint)>);

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
            .cogo_points()
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
        let mut current = Vec::new();
        for source_id in source_ids {
            current.push(source_id);
            if current.len() == max_records {
                batches.push(super::LandXmlPlanSourceBatch {
                    source_ids: current,
                });
                current = Vec::new();
            }
        }
        if !current.is_empty() {
            batches.push(super::LandXmlPlanSourceBatch {
                source_ids: current,
            });
        }
        batches
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
            perimeter = finite_sum(perimeter, loop_probe.perimeter)?;
            twice_area = finite_sum(twice_area, loop_probe.twice_area)?;
            if segments_intersect(&all_segments, &loop_probe.segments, &mut budget)? {
                return Ok(preserved(parcel, "cross-loop or retraced boundary"));
            }
            all_segments.extend(loop_probe.segments);
        }
        if parcel.loops.is_empty() {
            return Ok(preserved(parcel, "missing CoordGeom boundary"));
        }
        if twice_area == 0.0 {
            return Ok(preserved(parcel, "zero-area boundary"));
        }
        let coordinate_area = finite_measure(twice_area.abs() * 0.5)?;
        let (perimeter_in_meters, area_in_square_meters, area_in_declared_square_units) =
            match &self.units {
                Some(units) => {
                    let square_meters =
                        finite_measure(coordinate_area * units.linear_scale_to_meters.powi(2))?;
                    let declared_scale = self
                        .area_scale_to_square_meters
                        .unwrap_or(units.linear_scale_to_meters.powi(2));
                    if !declared_scale.is_finite() || declared_scale <= 0.0 {
                        return Ok(preserved(parcel, "invalid declared area unit scale"));
                    }
                    (
                        Some(finite_measure(perimeter * units.linear_scale_to_meters)?),
                        Some(square_meters),
                        Some(finite_measure(square_meters / declared_scale)?),
                    )
                }
                None => (None, None, Some(coordinate_area)),
            };
        Ok(LandXmlParcelProbe {
            state: LandXmlParcelState::Analytic,
            perimeter_in_declared_linear_units: Some(perimeter),
            area_in_declared_square_units,
            declared_area: parcel.declared_area,
            declared_perimeter: parcel.declared_perimeter,
            perimeter_in_meters,
            area_in_square_meters,
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
    let mut area_origin = None;
    for item in geometry {
        budget.check()?;
        let Some(start) = document.resolve_point_with_budget(
            item.point_scope_id.as_ref(),
            &item.start,
            budget,
        )?
        else {
            return Ok(None);
        };
        let Some(end) =
            document.resolve_point_with_budget(item.point_scope_id.as_ref(), &item.end, budget)?
        else {
            return Ok(None);
        };
        if !finite_point(start) || !finite_point(end) {
            return Ok(None);
        }
        if previous_end.is_some_and(|previous| !same_point(previous, start)) {
            return Ok(None);
        }
        let origin = *area_origin.get_or_insert(start);
        let Some((length, integral, edges)) =
            geometry_measure(document, item, start, end, origin, budget)?
        else {
            return Ok(None);
        };
        perimeter = finite_sum(perimeter, length)?;
        twice_area = finite_sum(twice_area, integral)?;
        segments.extend(edges);
        previous_end = Some(end);
    }
    let (Some(first), Some(last)) = (
        geometry
            .first()
            .map(|item| {
                document.resolve_point_with_budget(
                    item.point_scope_id.as_ref(),
                    &item.start,
                    budget,
                )
            })
            .transpose()?
            .flatten(),
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
    area_origin: LandXmlPlanPoint,
    budget: &mut TopologyBudget<'_>,
) -> std::result::Result<Option<GeometryMeasure>, crate::LandXmlError> {
    match geometry.kind {
        super::LandXmlGeometryKind::Line => Ok(Some((
            distance(start, end)?,
            cross(start, end, area_origin)?,
            vec![(start, end)],
        ))),
        super::LandXmlGeometryKind::IrregularLine => {
            let mut points = Vec::with_capacity(geometry.intermediate_points.len() + 2);
            points.push(start);
            points.extend(geometry.intermediate_points.iter().copied());
            points.push(end);
            let mut length = 0.0;
            let mut integral = 0.0;
            for pair in points.windows(2) {
                if !finite_point(pair[0]) || !finite_point(pair[1]) {
                    return Ok(None);
                }
                length = finite_sum(length, distance(pair[0], pair[1])?)?;
                integral = finite_sum(integral, cross(pair[0], pair[1], area_origin)?)?;
            }
            let edges = points.windows(2).map(|pair| (pair[0], pair[1])).collect();
            Ok(Some((length, integral, edges)))
        }
        super::LandXmlGeometryKind::Curve => {
            let Some(center_location) = geometry.center.as_ref() else {
                return Ok(None);
            };
            let Some(center) = document.resolve_point_with_budget(
                geometry.point_scope_id.as_ref(),
                center_location,
                budget,
            )?
            else {
                return Ok(None);
            };
            if !finite_point(center) {
                return Ok(None);
            }
            let radius = geometry.radius.unwrap_or(distance(center, start)?);
            if radius <= EPSILON
                || !radius.is_finite()
                || (distance(center, start)? - radius).abs() > EPSILON
                || (distance(center, end)? - radius).abs() > EPSILON
            {
                return Ok(None);
            }
            let start_angle =
                (start.northing - center.northing).atan2(start.easting - center.easting);
            let end_angle = (end.northing - center.northing).atan2(end.easting - center.easting);
            let Some(delta) = arc_delta(
                start_angle,
                end_angle,
                geometry.rotation.as_deref(),
                geometry.declared_length,
                radius,
            ) else {
                return Ok(None);
            };
            let center_easting = center.easting - area_origin.easting;
            let center_northing = center.northing - area_origin.northing;
            let start_northing = start.northing - area_origin.northing;
            let start_easting = start.easting - area_origin.easting;
            let end_northing = end.northing - area_origin.northing;
            let end_easting = end.easting - area_origin.easting;
            let integral = center_easting * (end_northing - start_northing)
                - center_northing * (end_easting - start_easting)
                + radius * radius * delta;
            let edges = curve_edges(center, start, end, radius, start_angle, delta);
            Ok(Some((
                finite_measure(radius * delta.abs())?,
                finite_measure(integral)?,
                edges,
            )))
        }
    }
}

/// A bounded, deterministic polyline is used only for topology intersection
/// checks; analytic perimeter and area remain the exact circular formulae.
fn curve_edges(
    center: LandXmlPlanPoint,
    start: LandXmlPlanPoint,
    end: LandXmlPlanPoint,
    radius: f64,
    start_angle: f64,
    delta: f64,
) -> Vec<(LandXmlPlanPoint, LandXmlPlanPoint)> {
    const MAX_SEGMENTS: usize = 64;
    let count = ((delta.abs() / std::f64::consts::TAU * MAX_SEGMENTS as f64).ceil() as usize)
        .clamp(1, MAX_SEGMENTS);
    let mut points = Vec::with_capacity(count + 1);
    points.push(start);
    for index in 1..count {
        let angle = start_angle + delta * index as f64 / count as f64;
        points.push(LandXmlPlanPoint {
            northing: center.northing + radius * angle.sin(),
            easting: center.easting + radius * angle.cos(),
            elevation: None,
        });
    }
    points.push(end);
    points.windows(2).map(|pair| (pair[0], pair[1])).collect()
}
