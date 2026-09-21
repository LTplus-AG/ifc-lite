/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::super::{LandXmlGeometryKind, LandXmlPlanGeometry, LandXmlPlanPointLocation};
use super::state::properties;
use super::value::{optional_finite, optional_positive, point, points_limited, source_id};
use super::*;

impl Parser<'_> {
    pub(super) fn begin_feature(&mut self, attributes: Attributes) -> Result<()> {
        if self.feature_ordinal >= self.limits.max_plan_features {
            return Err(error(Code::LimitExceeded, "PlanFeature limit exceeded"));
        }
        self.feature_ordinal += 1;
        let ordinal = self.feature_ordinal;
        self.active.push(Active::Feature(LandXmlPlanFeature {
            source_id: source_id("PlanFeature", ordinal, &attributes),
            ordinal,
            name: attr(&attributes, "name").map(str::to_owned),
            code: attr(&attributes, "code").map(str::to_owned),
            description: attr(&attributes, "desc").map(str::to_owned),
            properties: properties(&attributes),
            geometry: Vec::new(),
            locations: Vec::new(),
        }));
        self.active_depths.push(self.frames.len());
        Ok(())
    }
    pub(super) fn begin_parcel(&mut self, attributes: Attributes) -> Result<()> {
        if self.parcel_ordinal >= self.limits.max_parcels {
            return Err(error(Code::LimitExceeded, "Parcel limit exceeded"));
        }
        self.parcel_ordinal += 1;
        let ordinal = self.parcel_ordinal;
        // Bad parcel declarations must not abort a document that has valid
        // terrain or neighbouring plan records. Keep the complete parcel
        // envelope and make only this parcel preserved-only.
        let declared_area = optional_finite(&attributes, "area", "Parcel");
        let declared_perimeter = optional_finite(&attributes, "perimeter", "Parcel");
        let preservation_reason = declared_area
            .as_ref()
            .err()
            .or_else(|| declared_perimeter.as_ref().err())
            .map(|error| error.message.clone());
        self.active.push(Active::Parcel(LandXmlParcel {
            source_id: source_id("Parcel", ordinal, &attributes),
            ordinal,
            name: attr(&attributes, "name").map(str::to_owned),
            code: attr(&attributes, "code").map(str::to_owned),
            description: attr(&attributes, "desc").map(str::to_owned),
            title: None,
            declared_area: declared_area.ok().flatten(),
            declared_perimeter: declared_perimeter.ok().flatten(),
            declared_area_unit: attr(&attributes, "areaUnit").map(str::to_owned),
            properties: properties(&attributes),
            loops: Vec::new(),
            preservation_reason,
        }));
        self.active_depths.push(self.frames.len());
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
        let mut invalid_reason = (kind == LandXmlGeometryKind::Curve
            && !matches!(attr(&attributes, "rot"), Some("cw" | "ccw")))
        .then_some("Curve rot must be cw or ccw".to_owned());
        let radius = match optional_positive(&attributes, "radius", local) {
            Ok(radius) => radius,
            Err(error) => {
                invalid_reason.get_or_insert(error.message);
                None
            }
        };
        let declared_length = match optional_finite(&attributes, "length", local) {
            Ok(length) => length,
            Err(error) => {
                invalid_reason.get_or_insert(error.message);
                None
            }
        };
        self.geometry = Some(GeometryBuilder {
            kind,
            depth: self.frames.len(),
            loop_ordinal: match self.active.last() {
                Some(Active::Parcel(parcel)) => Some(parcel.loops.len()),
                _ => None,
            },
            properties: properties(&attributes),
            rotation: attr(&attributes, "rot").map(str::to_owned),
            radius,
            declared_length,
            start: None,
            end: None,
            center: None,
            pi: None,
            intermediate_points: Vec::new(),
            invalid: invalid_reason.is_some(),
        });
        if let Some(reason) = invalid_reason {
            self.preserve_malformed_parcel(&reason)?;
        }
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
                let pnt_ref = attr(&attributes, "pntRef").map(str::to_owned);
                let point = (!text.trim().is_empty())
                    .then(|| point(&text))
                    .transpose()?;
                if point.is_some() {
                    self.reserve_vertices(1)?;
                }
                self.cogo_ordinal += 1;
                let scope_id = self
                    .scope_stack
                    .last()
                    .map(|(_, scope)| scope.clone())
                    .ok_or_else(|| error(Code::InvalidSemantic, "CgPoint outside CgPoints"))?;
                let record = LandXmlCgPoint {
                    source_id: source_id("CgPoint", self.cogo_ordinal, &attributes),
                    scope_id,
                    ordinal: self.cogo_ordinal,
                    name: attr(&attributes, "name").map(str::to_owned),
                    code: attr(&attributes, "code").map(str::to_owned),
                    description: attr(&attributes, "desc").map(str::to_owned),
                    point,
                    pnt_ref,
                    properties: properties(&attributes),
                };
                self.reference_index.insert(&record);
                self.cogo_points.push(record);
            }
            Capture::Monument {
                attributes, text, ..
            } => {
                if self.monuments.len() >= self.limits.max_monuments {
                    return Err(error(Code::LimitExceeded, "Monument limit exceeded"));
                }
                let pnt_ref = attr(&attributes, "pntRef").map(str::to_owned);
                let point = if text.trim().is_empty() {
                    None
                } else {
                    self.reserve_vertices(1)?;
                    Some(point(&text)?)
                };
                self.monument_ordinal += 1;
                self.monuments.push(LandXmlMonument {
                    source_id: source_id("Monument", self.monument_ordinal, &attributes),
                    point_scope_id: self.reference_scope.clone(),
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
                let location = if text.trim().is_empty() {
                    let Some(pnt_ref) = pnt_ref else {
                        return self
                            .reject_malformed_geometry("point is missing coordinates and pntRef");
                    };
                    LandXmlPlanPointLocation::PointReference { pnt_ref }
                } else {
                    let point = match point(&text) {
                        Ok(point) => point,
                        Err(error) => return self.reject_malformed_geometry(&error.message),
                    };
                    self.reserve_vertices(1)?;
                    LandXmlPlanPointLocation::Coordinates { point, pnt_ref }
                };
                if role == "__location" {
                    if let Some(Active::Feature(feature)) = self.active.last_mut() {
                        feature.locations.push(location);
                        return Ok(());
                    }
                    return Err(error(Code::InvalidSemantic, "Location outside PlanFeature"));
                }
                let geometry = self.geometry.as_mut().ok_or_else(|| {
                    error(Code::InvalidSemantic, "point outside CoordGeom primitive")
                })?;
                let duplicate = match role.as_str() {
                    "Start" => geometry.start.replace(location).is_some(),
                    "End" => geometry.end.replace(location).is_some(),
                    "Center" => geometry.center.replace(location).is_some(),
                    "PI" => geometry.pi.replace(location).is_some(),
                    _ => return Err(error(Code::InvalidSemantic, "unknown CoordGeom point")),
                };
                if duplicate {
                    return self.reject_malformed_geometry("duplicate CoordGeom point");
                }
            }
            Capture::PointList {
                dimension, text, ..
            } => {
                let points = match points_limited(
                    &text,
                    dimension,
                    self.limits.max_vertices - self.vertices,
                ) {
                    Ok(points) => points,
                    Err(error) => return self.reject_malformed_geometry(&error.message),
                };
                self.reserve_vertices(points.len())?;
                let geometry = self.geometry.as_mut().ok_or_else(|| {
                    error(Code::InvalidSemantic, "PntList outside CoordGeom primitive")
                })?;
                if geometry.kind != LandXmlGeometryKind::IrregularLine {
                    return self
                        .reject_malformed_geometry("PntList is supported only by IrregularLine");
                }
                geometry.intermediate_points.extend(points);
            }
            Capture::Title { attributes, .. } => {
                if let Some(Active::Parcel(parcel)) = self.active.last_mut() {
                    parcel.title = attr(&attributes, "name").map(str::to_owned);
                }
            }
        }
        Ok(())
    }
    pub(super) fn finish_geometry(&mut self) -> Result<()> {
        let geometry = self.geometry.take().expect("geometry depth checked");
        if geometry.invalid {
            return Ok(());
        }
        let Some(start) = geometry.start else {
            return self.preserve_malformed_parcel("CoordGeom primitive is missing Start");
        };
        let Some(end) = geometry.end else {
            return self.preserve_malformed_parcel("CoordGeom primitive is missing End");
        };
        if geometry.kind == LandXmlGeometryKind::Curve && geometry.center.is_none() {
            return self.preserve_malformed_parcel("Curve is missing Center");
        }
        let (owner, ordinal) = match self.active.last() {
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
        let loop_identity = geometry
            .loop_ordinal
            .map(|value| format!(":loop:{value}"))
            .unwrap_or_default();
        let record = LandXmlPlanGeometry {
            source_id: LandXmlSourceId(format!(
                "{}{}:CoordGeom:{}",
                owner.0, loop_identity, ordinal
            )),
            ordinal,
            kind: geometry.kind,
            point_scope_id: self.reference_scope.clone(),
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
        match self.active.last_mut() {
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
        self.active_depths.pop();
        match self
            .active
            .pop()
            .ok_or_else(|| error(Code::InvalidSemantic, "missing plan source record"))?
        {
            Active::Feature(feature) => self.features.push(feature),
            Active::Parcel(parcel) => self.parcels.push(parcel),
        };
        Ok(())
    }
    fn preserve_malformed_parcel(&mut self, reason: &str) -> Result<()> {
        if let Some(Active::Parcel(parcel)) = self.active.last_mut() {
            parcel
                .preservation_reason
                .get_or_insert_with(|| reason.to_owned());
            return Ok(());
        }
        Err(error(Code::InvalidSemantic, reason))
    }
    fn reject_malformed_geometry(&mut self, reason: &str) -> Result<()> {
        if let Some(geometry) = self.geometry.as_mut() {
            geometry.invalid = true;
        }
        self.preserve_malformed_parcel(reason)
    }
    pub(super) fn add_property(&mut self, attributes: &Attributes) -> Result<()> {
        let key = attr(attributes, "label")
            .or_else(|| attr(attributes, "name"))
            .ok_or_else(|| error(Code::InvalidSemantic, "Property is missing label"))?;
        let value = attr(attributes, "value").unwrap_or_default().to_owned();
        match self.active.last_mut() {
            Some(Active::Feature(feature)) => {
                feature.properties.insert(key.to_owned(), value);
            }
            Some(Active::Parcel(parcel)) => {
                parcel.properties.insert(key.to_owned(), value);
            }
            None => {
                return Err(error(
                    Code::InvalidSemantic,
                    "Property outside plan source record",
                ))
            }
        }
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
    pub(crate) fn document(self) -> LandXmlPlanDocument {
        LandXmlPlanDocument {
            version: self.version,
            units: self.units,
            area_unit: self.area_unit,
            area_scale_to_square_meters: self.area_scale_to_square_meters,
            cogo_points: self.cogo_points,
            monuments: self.monuments,
            plan_features: self.features,
            parcels: self.parcels,
            warnings: Vec::new(),
            reference_index: std::cell::RefCell::new(Some(self.reference_index)),
        }
    }
}
