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

use crate::placement::Axis2Placement;
use crate::{Error, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

/// The extrusion axis of an `IfcExtrudedAreaSolid` or a subtype.
pub(crate) struct ExtrusionParams {
    /// `ExtrudedDirection` as authored (unnormalised, never zero-length).
    pub(crate) direction: Vector3<f64>,
    /// `Depth`, in file units.
    pub(crate) depth: f64,
    /// `Position`, in file units; `None` when absent or `$` (the identity).
    /// A Position that is present but does not read is an error.
    pub(crate) position: Option<Matrix4<f64>>,
}

impl ExtrusionParams {
    /// Decode attributes 1..=3 of `entity`. `name` prefixes the error
    /// messages (`"ExtrudedAreaSolid"`, `"ExtrudedAreaSolidTapered"`).
    ///
    /// Errors, in this order: a missing, unresolvable or non-`IfcDirection`
    /// `ExtrudedDirection`, a zero-length one, zero Z (`ValidExtrusionDirection`),
    /// a missing `Depth`, an unparseable `Position`.
    pub(crate) fn decode(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        name: &str,
    ) -> Result<Self> {
        let direction_attr = entity
            .get(2)
            .ok_or_else(|| Error::geometry(format!("{name} missing ExtrudedDirection")))?;
        let direction_id = direction_attr
            .as_entity_ref()
            .ok_or_else(|| Error::geometry(format!("{name} ExtrudedDirection is not a reference")))?;
        // The leaf rule: an `IfcDirection` of 2 or 3 finite ratios, anything
        // else refused and counted. A missing Z used to read as 1.0 here
        // (extruding `(1,0)` along `(1,0,1)`); the IFC rule
        // `ValidExtrusionDirection` needs a non-zero Z, so a 2D direction
        // (z = 0) is refused, not given an invented one (D25, D26).
        let direction = Vector3::from(decoder.direction3(direction_id)?);
        if direction.norm_squared() <= f64::EPSILON {
            return Err(Error::geometry(format!(
                "{name} has zero-length ExtrudedDirection"
            )));
        }
        if direction.z == 0.0 {
            return Err(Error::geometry(format!(
                "{name} ExtrudedDirection has no Z component (ValidExtrusionDirection)"
            )));
        }

        let depth = entity
            .get_float(3)
            .ok_or_else(|| Error::geometry(format!("{name} missing Depth")))?;

        let position = match decoder.resolve_optional(entity, 1)? {
            Some(pos) => Some(Axis2Placement::read_3d(&pos, decoder)?.matrix()),
            None => None,
        };

        Ok(Self { direction, depth, position })
    }
}
