/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::super::{
    LandXmlGeometryKind, LandXmlPlanGeometry, LandXmlPlanPoint, LandXmlPlanPointLocation,
};
use super::state::properties;
use super::*;

impl Parser<'_> {
    pub(super) fn begin_feature(&mut self, attributes: Attributes) -> Result<()> {
        if self.features.len() >= self.limits.max_plan_features {
            return Err(error(Code::LimitExceeded, "PlanFeature limit exceeded"));
        }
        if self.active.is_some() {
            return Err(error(
                Code::InvalidSemantic,
                "nested PlanFeature or Parcel is not valid",
            ));
        }
        let ordinal = self.features.len() + 1;
        self.active = Some(Active::Feature(LandXmlPlanFeature {
            source_id: source_id("PlanFeature", ordinal, &attributes),
            ordinal,
            name: attr(&attributes, "name").map(str::to_owned),
            code: attr(&attributes, "code").map(str::to_owned),
            description: attr(&attributes, "desc").map(str::to_owned),
            properties: properties(&attributes),
            geometry: Vec::new(),
        }));
        Ok(())
    }
    pub(super) fn begin_parcel(&mut self, attributes: Attributes) -> Result<()> {
        if self.parcels.len() >= self.limits.max_parcels {
            return Err(error(Code::LimitExceeded, "Parcel limit exceeded"));
        }
        if self.active.is_some() {
            return Err(error(
                Code::InvalidSemantic,
                "nested PlanFeature or Parcel is not valid",
            ));
        }
        let ordinal = self.parcels.len() + 1;
        self.active = Some(Active::Parcel(LandXmlParcel {
            source_id: source_id("Parcel", ordinal, &attributes),
            ordinal,
            name: attr(&attributes, "name").map(str::to_owned),
            code: attr(&attributes, "code").map(str::to_owned),
            description: attr(&attributes, "desc").map(str::to_owned),
            declared_area: optional_finite(&attributes, "area", "Parcel")?,
            declared_perimeter: optional_finite(&attributes, "perimeter", "Parcel")?,
            properties: properties(&attributes),
            loops: Vec::new(),
            labels: Vec::new(),
        }));
        Ok(())
    }
    pub(super) fn begin_geometry(&mut self, local: &str, attributes: Attributes) -> Result<()> {
        if self.geometry_count >= self.limits.max_geometry {
            return Err(error(
                Code::LimitExceeded,
                "CoordGeom primitive limit exceeded",
            ));
        }
        self.geometry_count += 1;
        let kind = match local {
            "Line" => LandXmlGeometryKind::Line,
            "Curve" => LandXmlGeometryKind::Curve,
            "IrregularLine" => LandXmlGeometryKind::IrregularLine,
            _ => unreachable!("element is matched above"),
        };
        if kind == LandXmlGeometryKind::Curve {
            let rotation = attr(&attributes, "rot")
                .ok_or_else(|| error(Code::InvalidSemantic, "Curve is missing rot"))?;
            if !matches!(rotation, "cw" | "ccw") {
                return Err(error(Code::InvalidSemantic, "Curve rot must be cw or ccw"));
            }
        }
        self.geometry = Some(GeometryBuilder {
            kind,
            depth: self.frames.len(),
            properties: properties(&attributes),
            rotation: attr(&attributes, "rot").map(str::to_owned),
            radius: optional_positive(&attributes, "radius", local)?,
            declared_length: optional_finite(&attributes, "length", local)?,
            start: None,
            end: None,
            center: None,
            pi: None,
            intermediate_points: Vec::new(),
        });
        Ok(())
    }
    pub(super) fn finish_capture(&mut self) -> Result<()> {
        let capture = self
            .capture
            .take()
            .ok_or_else(|| error(Code::InvalidSemantic, "missing capture"))?;
        match capture {
            Capture::CgPoint {
                attributes, text, ..
            } => {
                if self.cogo_points.len() >= self.limits.max_cogo_points {
                    return Err(error(Code::LimitExceeded, "CgPoint limit exceeded"));
                }
                self.reserve_vertices(1)?;
                self.cogo_ordinal += 1;
                let scope_id = self
                    .scope_id
                    .clone()
                    .ok_or_else(|| error(Code::InvalidSemantic, "CgPoint outside CgPoints"))?;
                self.cogo_points.push(LandXmlCgPoint {
                    source_id: source_id("CgPoint", self.cogo_ordinal, &attributes),
                    scope_id,
                    ordinal: self.cogo_ordinal,
                    name: attr(&attributes, "name").map(str::to_owned),
                    code: attr(&attributes, "code").map(str::to_owned),
                    description: attr(&attributes, "desc").map(str::to_owned),
                    point: point(&text)?,
                    properties: properties(&attributes),
                });
            }
            Capture::Monument {
                attributes, text, ..
            } => {
                if self.monuments.len() >= self.limits.max_monuments {
                    return Err(error(Code::LimitExceeded, "Monument limit exceeded"));
                }
                let pnt_ref = attr(&attributes, "pntRef").map(str::to_owned);
                if pnt_ref.is_some() && !text.trim().is_empty() {
                    return Err(error(
                        Code::InvalidSemantic,
                        "Monument must use coordinates or pntRef, not both",
                    ));
                }
                let point = if text.trim().is_empty() {
                    None
                } else {
                    self.reserve_vertices(1)?;
                    Some(point(&text)?)
                };
                self.monument_ordinal += 1;
                self.monuments.push(LandXmlMonument {
                    source_id: source_id("Monument", self.monument_ordinal, &attributes),
                    point_scope_id: self.scope_id.clone(),
                    ordinal: self.monument_ordinal,
                    name: attr(&attributes, "name").map(str::to_owned),
                    code: attr(&attributes, "code").map(str::to_owned),
                    description: attr(&attributes, "desc").map(str::to_owned),
                    pnt_ref,
                    point,
                    properties: properties(&attributes),
                });
            }
            Capture::Point {
                role,
                pnt_ref,
                text,
                ..
            } => {
                let location = if let Some(pnt_ref) = pnt_ref {
                    if !text.trim().is_empty() {
                        return Err(error(
                            Code::InvalidSemantic,
                            "point must use coordinates or pntRef, not both",
                        ));
                    }
                    LandXmlPlanPointLocation::PointReference { pnt_ref }
                } else {
                    self.reserve_vertices(1)?;
                    LandXmlPlanPointLocation::Coordinates {
                        point: point(&text)?,
                    }
                };
                let geometry = self.geometry.as_mut().ok_or_else(|| {
                    error(Code::InvalidSemantic, "point outside CoordGeom primitive")
                })?;
                let target = match role.as_str() {
                    "Start" => &mut geometry.start,
                    "End" => &mut geometry.end,
                    "Center" => &mut geometry.center,
                    "PI" => &mut geometry.pi,
                    _ => return Err(error(Code::InvalidSemantic, "unknown CoordGeom point")),
                };
                if target.replace(location).is_some() {
                    return Err(error(Code::InvalidSemantic, "duplicate CoordGeom point"));
                }
            }
            Capture::PointList {
                dimension, text, ..
            } => {
                let points = points(&text, dimension)?;
                self.reserve_vertices(points.len())?;
                let geometry = self.geometry.as_mut().ok_or_else(|| {
                    error(Code::InvalidSemantic, "PntList outside CoordGeom primitive")
                })?;
                if geometry.kind != LandXmlGeometryKind::IrregularLine {
                    return Err(error(
                        Code::InvalidSemantic,
                        "PntList is supported only by IrregularLine",
                    ));
                }
                geometry.intermediate_points.extend(points);
            }
            Capture::Label { text, .. } => {
                if let Some(Active::Parcel(parcel)) = &mut self.active {
                    let text = text.trim();
                    if !text.is_empty() {
                        parcel.labels.push(text.to_owned());
                    }
                }
            }
        }
        Ok(())
    }
    pub(super) fn finish_geometry(&mut self) -> Result<()> {
        let geometry = self.geometry.take().expect("geometry depth checked");
        let start = geometry.start.ok_or_else(|| {
            error(
                Code::InvalidSemantic,
                "CoordGeom primitive is missing Start",
            )
        })?;
        let end = geometry
            .end
            .ok_or_else(|| error(Code::InvalidSemantic, "CoordGeom primitive is missing End"))?;
        if geometry.kind == LandXmlGeometryKind::Curve && geometry.center.is_none() {
            return Err(error(Code::InvalidSemantic, "Curve is missing Center"));
        }
        let (owner, ordinal) = match self.active.as_ref() {
            Some(Active::Feature(feature)) => (&feature.source_id, feature.geometry.len() + 1),
            Some(Active::Parcel(parcel)) => (
                &parcel.source_id,
                parcel.loops.last().map_or(0, Vec::len) + 1,
            ),
            None => {
                return Err(error(
                    Code::InvalidSemantic,
                    "CoordGeom primitive outside source record",
                ))
            }
        };
        let record = LandXmlPlanGeometry {
            source_id: LandXmlSourceId(format!("{}:CoordGeom:{}", owner.0, ordinal)),
            ordinal,
            kind: geometry.kind,
            point_scope_id: self.scope_id.clone(),
            start,
            end,
            center: geometry.center,
            pi: geometry.pi,
            intermediate_points: geometry.intermediate_points,
            rotation: geometry.rotation,
            radius: geometry.radius,
            declared_length: geometry.declared_length,
            properties: geometry.properties,
        };
        match self.active.as_mut() {
            Some(Active::Feature(feature)) => feature.geometry.push(record),
            Some(Active::Parcel(parcel)) => parcel
                .loops
                .last_mut()
                .ok_or_else(|| error(Code::InvalidSemantic, "Parcel primitive outside CoordGeom"))?
                .push(record),
            None => unreachable!("active checked"),
        }
        Ok(())
    }
    pub(super) fn finish_active(&mut self) -> Result<()> {
        match self
            .active
            .take()
            .ok_or_else(|| error(Code::InvalidSemantic, "missing plan source record"))?
        {
            Active::Feature(feature) => self.features.push(feature),
            Active::Parcel(parcel) => self.parcels.push(parcel),
        };
        Ok(())
    }
    pub(super) fn reserve_vertices(&mut self, added: usize) -> Result<()> {
        self.vertices = self
            .vertices
            .checked_add(added)
            .ok_or_else(|| error(Code::LimitExceeded, "plan vertex limit exceeded"))?;
        if self.vertices > self.limits.max_vertices {
            return Err(error(Code::LimitExceeded, "plan vertex limit exceeded"));
        }
        Ok(())
    }
    pub(super) fn path(&self, expected: &[&str]) -> bool {
        self.frames.len() == expected.len()
            && self
                .frames
                .iter()
                .zip(expected)
                .all(|(frame, local)| frame.target && frame.local == *local)
    }
    pub(super) fn document(self) -> LandXmlPlanDocument {
        LandXmlPlanDocument {
            version: self.version,
            units: self.units,
            cogo_points: self.cogo_points,
            monuments: self.monuments,
            plan_features: self.features,
            parcels: self.parcels,
            warnings: Vec::new(),
        }
    }
}

fn source_id(element: &str, ordinal: usize, attributes: &Attributes) -> LandXmlSourceId {
    let identity = attr(attributes, "oID")
        .or_else(|| attr(attributes, "name"))
        .unwrap_or("unnamed");
    LandXmlSourceId(format!("landxml:{element}:{ordinal}:{identity}"))
}
fn optional_finite(attributes: &Attributes, name: &str, context: &str) -> Result<Option<f64>> {
    attr(attributes, name)
        .map(|value| finite(value, context))
        .transpose()
}
fn optional_positive(attributes: &Attributes, name: &str, context: &str) -> Result<Option<f64>> {
    optional_finite(attributes, name, context)?
        .map(|value| {
            if value > 0.0 {
                Ok(value)
            } else {
                Err(error(
                    Code::InvalidSemantic,
                    format!("{context} {name} must be positive"),
                ))
            }
        })
        .transpose()
}
fn finite(value: &str, context: &str) -> Result<f64> {
    let value = value.parse::<f64>().map_err(|_| {
        error(
            Code::InvalidSemantic,
            format!("{context} has invalid numeric value"),
        )
    })?;
    if value.is_finite() {
        Ok(value)
    } else {
        Err(error(
            Code::InvalidSemantic,
            format!("{context} requires a finite numeric value"),
        ))
    }
}
fn point(text: &str) -> Result<LandXmlPlanPoint> {
    let values: Vec<f64> = text
        .split_ascii_whitespace()
        .map(|value| finite(value, "coordinate"))
        .collect::<Result<_>>()?;
    match values.as_slice() {
        [northing, easting] => Ok(LandXmlPlanPoint {
            northing: *northing,
            easting: *easting,
            elevation: None,
        }),
        [northing, easting, elevation] => Ok(LandXmlPlanPoint {
            northing: *northing,
            easting: *easting,
            elevation: Some(*elevation),
        }),
        _ => Err(error(
            Code::InvalidSemantic,
            "coordinate requires northing easting [elevation]",
        )),
    }
}
fn points(text: &str, dimension: usize) -> Result<Vec<LandXmlPlanPoint>> {
    let values: Vec<f64> = text
        .split_ascii_whitespace()
        .map(|value| finite(value, "PntList coordinate"))
        .collect::<Result<_>>()?;
    if values.len() < dimension * 2 || !values.len().is_multiple_of(dimension) {
        return Err(error(
            Code::InvalidSemantic,
            "PntList requires at least two complete coordinates",
        ));
    }
    Ok(values
        .chunks_exact(dimension)
        .map(|value| LandXmlPlanPoint {
            northing: value[0],
            easting: value[1],
            elevation: (dimension == 3).then_some(value[2]),
        })
        .collect())
}
