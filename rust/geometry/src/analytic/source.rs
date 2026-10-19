// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Owned EXPRESS values beside interpreted geometry. No sampling or unit conversion.
use crate::{Error, Result};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub(super) const MAX_SOURCE_VALUE_DEPTH:usize=32;
pub(super) const MAX_SOURCE_VALUES:usize=1_000_000;

/// Original selector types, typed wrappers and source references survive intact.
/// Reals are decoded f64 values, not original STEP lexical spellings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum SourceValue {
    EntityRef(u32),
    String(String),
    Integer(i64),
    Real(f64),
    Binary(String),
    Enum(String),
    List(Vec<SourceValue>),
    Typed {
        name: String,
        value: Box<SourceValue>,
    },
    Null,
    Derived,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceRecord {
    pub id: u32,
    pub ifc_type_name: String,
    /// Exact EXPRESS attribute names; original values, never interpreted radians.
    pub attributes: BTreeMap<String, SourceValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnalyticBoundarySource {
    pub root_entity_id: u32,
    /// Failed capture never exposes a partial graph as complete provenance.
    pub capture_status: super::AnalyticStatus,
    /// File plane-angle units -> radians. Length coefficients remain file units.
    pub plane_angle_to_radians: f64,
    /// Reached profile/curve/composite/basis/placement/point records, indexed by source ID.
    /// Composite Segments order, SameSense and Transition define source traversal;
    /// the matching loop's segments contain the separate interpreted traversal.
    #[serde(serialize_with = "serialize_source_records")]
    pub records: BTreeMap<u32, SourceRecord>,
}

// Object serializers require string keys. Keep each actual record borrowed and
// its numeric source ID intact; JSON already represents these map keys as text.
fn serialize_source_records<S: serde::Serializer>(records: &BTreeMap<u32, SourceRecord>,
    serializer: S) -> std::result::Result<S::Ok, S::Error> {
    serializer.collect_map(records.iter().map(|(id, record)| (id.to_string(), record)))
}

#[derive(Default)]
pub(super) struct SourceCapture {
    records: BTreeMap<u32, SourceRecord>,
    values: usize,
    enabled: bool,
    failure: Option<String>,
}
impl SourceCapture {
    pub fn enabled() -> Self {
        Self {
            enabled: true,
            ..Self::default()
        }
    }
    pub fn finish(mut self, root_entity_id: u32, scale: f64) -> AnalyticBoundarySource {
        if !scale.is_finite() || scale <= 0.0 {
            self.fail("invalid source plane-angle unit scale".to_owned());
        }
        AnalyticBoundarySource {
            root_entity_id,
            capture_status: self.failure.map_or(super::AnalyticStatus::Complete,
                super::AnalyticStatus::Unsupported),
            plane_angle_to_radians: scale,
            records: self.records,
        }
    }

    fn fail(&mut self, reason: String) {
        self.records.clear();
        self.enabled = false;
        if self.failure.is_none() { self.failure = Some(reason); }
    }

    pub fn record(&mut self, entity: &DecodedEntity, decoder: &mut EntityDecoder) {
        if let Err(error) = self.try_record(entity, decoder) {
            self.fail(error.to_string());
        }
    }

    /// Called by the existing curve interpreter when it reaches each record.
    /// Only fixed-depth coefficient dependencies are captured here; composite
    /// and trimmed curve traversal remains exclusively in CurveWalk.
    fn try_record(&mut self, entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let mut pending = vec![entity.clone()];
        let mut visited = std::collections::HashSet::new();
        let mut work = 0;
        while let Some(entity) = pending.pop() {
            work += 1;
            if work > 1_000_000 {
                return Err(invalid("source coefficient work budget exceeded"));
            }
            if !visited.insert(entity.id) || self.records.contains_key(&entity.id) {
                continue;
            }
            self.record_values(&entity)?;
            pending.extend(Self::coefficients(&entity, decoder)?);
        }
        Ok(())
    }

    fn record_values(&mut self, entity: &DecodedEntity) -> Result<()> {
        let names: &[&str] = match entity.ifc_type {
            IfcType::IfcRectangleProfileDef => {
                &["ProfileType", "ProfileName", "Position", "XDim", "YDim"]
            }
            IfcType::IfcArbitraryClosedProfileDef => &["ProfileType", "ProfileName", "OuterCurve"],
            IfcType::IfcArbitraryProfileDefWithVoids => &["ProfileType", "ProfileName", "OuterCurve", "InnerCurves"],
            IfcType::IfcCircleProfileDef => &["ProfileType", "ProfileName", "Position", "Radius"],
            IfcType::IfcPolyline => &["Points"],
            IfcType::IfcIndexedPolyCurve => &["Points", "Segments", "SelfIntersect"],
            IfcType::IfcCompositeCurve | IfcType::IfcCompositeCurveOnSurface => {
                &["Segments", "SelfIntersect"]
            }
            IfcType::IfcCompositeCurveSegment => &["Transition", "SameSense", "ParentCurve"],
            IfcType::IfcTrimmedCurve => &[
                "BasisCurve",
                "Trim1",
                "Trim2",
                "SenseAgreement",
                "MasterRepresentation",
            ],
            IfcType::IfcLine => &["Pnt", "Dir"],
            IfcType::IfcExtrudedAreaSolid => &["SweptArea", "Position", "ExtrudedDirection", "Depth"],
            IfcType::IfcSweptDiskSolid =>
                &["Directrix", "Radius", "InnerRadius", "StartParam", "EndParam"],
            IfcType::IfcBSplineCurveWithKnots => &["Degree", "ControlPointsList", "CurveForm",
                "ClosedCurve", "SelfIntersect", "KnotMultiplicities", "Knots", "KnotSpec"],
            IfcType::IfcRationalBSplineCurveWithKnots => &["Degree", "ControlPointsList", "CurveForm",
                "ClosedCurve", "SelfIntersect", "KnotMultiplicities", "Knots", "KnotSpec", "WeightsData"],
            IfcType::IfcCircle => &["Position", "Radius"],
            IfcType::IfcAxis2Placement2D => &["Location", "RefDirection"],
            IfcType::IfcAxis2Placement3D => &["Location", "Axis", "RefDirection"],
            IfcType::IfcCartesianPoint => &["Coordinates"],
            IfcType::IfcDirection => &["DirectionRatios"],
            IfcType::IfcVector => &["Orientation", "Magnitude"],
            IfcType::IfcCartesianPointList2D | IfcType::IfcCartesianPointList3D => &["CoordList"],
            _ => return Err(invalid("unsupported source record type")),
        };
        if self.records.len() >= 100_000 {
            return Err(invalid("source records exceed work budget"));
        }
        let attributes = names
            .iter()
            .enumerate()
            .filter_map(|(i, name)| entity.get(i).map(|v| (name, v)))
            .map(|(name, v)| Ok(((*name).to_owned(), self.value(v, 0)?)))
            .collect::<Result<_>>()?;
        self.records.insert(
            entity.id,
            SourceRecord {
                id: entity.id,
                ifc_type_name: entity.ifc_type.name().to_owned(),
                attributes,
            },
        );
        Ok(())
    }

    fn coefficients(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<DecodedEntity>> {
        let mut dependencies = Vec::new();
        use IfcType::*;
        // Finite EXPRESS dependency ranks: curve -> placement/vector -> point/direction.
        // Never follow ParentCurve/BasisCurve here (CurveWalk owns those edges).
        let slots: &[(usize, &[IfcType])] = match entity.ifc_type {
            IfcRectangleProfileDef | IfcCircleProfileDef => &[(2, &[IfcAxis2Placement2D])],
            IfcLine => &[(0, &[IfcCartesianPoint]), (1, &[IfcVector])],
            IfcExtrudedAreaSolid => &[(1, &[IfcAxis2Placement3D]), (2, &[IfcDirection])],
            IfcCircle => &[(0, &[IfcAxis2Placement2D, IfcAxis2Placement3D])],
            IfcIndexedPolyCurve => &[(0, &[IfcCartesianPointList2D, IfcCartesianPointList3D])],
            IfcAxis2Placement2D => &[(0, &[IfcCartesianPoint]), (1, &[IfcDirection])],
            IfcAxis2Placement3D => &[
                (0, &[IfcCartesianPoint]),
                (1, &[IfcDirection]),
                (2, &[IfcDirection]),
            ],
            IfcVector => &[(0, &[IfcDirection])],
            _ => &[],
        };
        for &(slot, expected) in slots {
            if let Some(id) = entity.get_ref(slot) {
                dependencies.push(Self::coefficient(id, expected, decoder)?);
            }
        }
        if matches!(entity.ifc_type, IfcPolyline | IfcBSplineCurveWithKnots
            | IfcRationalBSplineCurveWithKnots) {
            let slot = if entity.ifc_type == IfcPolyline { 0 } else { 1 };
            if let Some(points) = entity.get_list(slot) {
                for point in points {
                    if let Some(id) = point.as_entity_ref() {
                        dependencies.push(Self::coefficient(id, &[IfcCartesianPoint], decoder)?);
                    }
                }
            }
        }
        if entity.ifc_type == IfcTrimmedCurve {
            for slot in [1, 2] {
                if let Some(selectors) = entity.get_list(slot) {
                    for selector in selectors {
                        if let Some(id) = selector.as_entity_ref() {
                            dependencies.push(Self::coefficient(
                                id,
                                &[IfcCartesianPoint],
                                decoder,
                            )?);
                        }
                    }
                }
            }
        }
        Ok(dependencies)
    }

    fn coefficient(
        id: u32,
        expected: &[IfcType],
        decoder: &mut EntityDecoder,
    ) -> Result<DecodedEntity> {
        let entity = decoder.decode_by_id(id)?;
        // Refuse a malformed coefficient edge before following it. Rank strictly
        // decreases on every valid edge; the global record set bounds revisits.
        if !expected.contains(&entity.ifc_type) {
            return Err(invalid("invalid source coefficient dependency"));
        }
        Ok(entity)
    }

    fn value(&mut self, value: &AttributeValue, depth: usize) -> Result<SourceValue> {
        self.values += 1;
        if depth >= MAX_SOURCE_VALUE_DEPTH || self.values > MAX_SOURCE_VALUES {
            return Err(invalid("source values exceed work budget"));
        }
        Ok(match value {
            AttributeValue::EntityRef(v) => SourceValue::EntityRef(*v),
            AttributeValue::String(v) => SourceValue::String(v.clone()),
            AttributeValue::Binary(v) => SourceValue::Binary(v.clone()),
            AttributeValue::Integer(v) => SourceValue::Integer(*v),
            AttributeValue::Float(v) if v.is_finite() => SourceValue::Real(*v),
            AttributeValue::Float(_) => return Err(invalid("nonfinite source coefficient")),
            AttributeValue::Enum(v) => SourceValue::Enum(v.clone()),
            AttributeValue::List(v) => SourceValue::List(
                v.iter()
                    .map(|x| self.value(x, depth + 1))
                    .collect::<Result<_>>()?,
            ),
            AttributeValue::Typed { name, value } => SourceValue::Typed {
                name: name.to_string(),
                value: Box::new(self.value(value, depth + 1)?),
            },
            AttributeValue::Null => SourceValue::Null,
            AttributeValue::Derived => SourceValue::Derived,
        })
    }
}
fn invalid(message: &str) -> Error {
    Error::geometry(message.to_owned())
}
