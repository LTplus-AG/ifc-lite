// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcExtrudedAreaSolid` attributes 1..=3 (`Position`, `ExtrudedDirection`,
//! `Depth`), decoded once for every reader: `ExtrudedAreaSolidProcessor`,
//! `ExtrudedAreaSolidTaperedProcessor` and the 2D profile extractor.
//!
//! The extractor used to decode them itself and had drifted: a missing `Depth`
//! became 1.0, a zero-length or non-`IfcDirection` `ExtrudedDirection` became
//! +Z, so the drawing showed a profile the 3D path refused (PROC-2, #7690).

use super::helpers::parse_axis2_placement_3d;
use crate::{Error, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

/// The extrusion axis of an `IfcExtrudedAreaSolid` or a subtype.
pub(crate) struct ExtrusionParams {
    /// `ExtrudedDirection` as authored (unnormalised, never zero-length).
    pub(crate) direction: Vector3<f64>,
    /// `Depth`, in file units.
    pub(crate) depth: f64,
    /// `Position`, in file units; `None` when absent, null, unresolvable or
    /// not an `IfcAxis2Placement3D` (the identity).
    pub(crate) position: Option<Matrix4<f64>>,
}

impl ExtrusionParams {
    /// Decode attributes 1..=3 of `entity`. `name` prefixes the error
    /// messages (`"ExtrudedAreaSolid"`, `"ExtrudedAreaSolidTapered"`).
    ///
    /// Errors, in this order: a missing, unresolvable or non-`IfcDirection`
    /// `ExtrudedDirection`, a zero-length one, a missing `Depth`, an
    /// unparseable `Position`.
    pub(crate) fn decode(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        name: &str,
    ) -> Result<Self> {
        let direction_attr = entity
            .get(2)
            .ok_or_else(|| Error::geometry(format!("{name} missing ExtrudedDirection")))?;
        let direction_entity = decoder
            .resolve_ref(direction_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve ExtrudedDirection".to_string()))?;
        if direction_entity.ifc_type != IfcType::IfcDirection {
            return Err(Error::geometry(format!(
                "Expected IfcDirection, got {}",
                direction_entity.ifc_type
            )));
        }
        let ratios = direction_entity
            .get(0)
            .ok_or_else(|| Error::geometry("IfcDirection missing ratios".to_string()))?
            .as_list()
            .ok_or_else(|| Error::geometry("Expected ratio list".to_string()))?;
        // A missing Z ratio is +Z, as it always was here (`helpers::parse_direction`
        // defaults it to 0 for placement axes).
        let ratio = |i: usize, default: f64| ratios.get(i).and_then(|v| v.as_float()).unwrap_or(default);
        let direction = Vector3::new(ratio(0, 0.0), ratio(1, 0.0), ratio(2, 1.0));
        if direction.norm_squared() <= f64::EPSILON {
            return Err(Error::geometry(format!(
                "{name} has zero-length ExtrudedDirection"
            )));
        }

        let depth = entity
            .get_float(3)
            .ok_or_else(|| Error::geometry(format!("{name} missing Depth")))?;

        let position = match entity.get(1) {
            Some(attr) if !attr.is_null() => match decoder.resolve_ref(attr)? {
                Some(pos) if pos.ifc_type == IfcType::IfcAxis2Placement3D => {
                    Some(parse_axis2_placement_3d(&pos, decoder)?)
                }
                _ => None,
            },
            _ => None,
        };

        Ok(Self { direction, depth, position })
    }
}
