// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Every tunable of scan element proposals, with documented defaults and
//! bounds. Lengths are metres in the model frame (after `scanToModel`).
use serde::{Deserialize, Serialize};

/// Schema of the model the proposals are for: it decides the pipe class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum ProposalSchema {
    #[serde(rename = "IFC2X3")]
    Ifc2x3,
    #[serde(rename = "IFC4")]
    Ifc4,
    #[serde(rename = "IFC4X3")]
    Ifc4x3,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ScanProposalOptions {
    /// Row-major 4x4 similarity (rotation, uniform scale, translation) from
    /// the frame the segmentation report is in to the IFC model frame
    /// (Z up, metres). Default identity: the report is already in it.
    pub scan_to_model: [f64; 16],
    /// Default `IFC4`. Non-vertical cylinders become `IfcFlowSegment` in
    /// IFC2X3 (no `IfcPipeSegment` there) and `IfcPipeSegment` otherwise.
    pub schema: ProposalSchema,
    /// Horizontal / vertical tolerance in the model frame. Default 10 degrees.
    pub classification_angle_degrees: f64,
    /// Two wall faces pair when parallel within this. Default 5 degrees.
    pub pairing_angle_degrees: f64,
    /// Paired faces make one wall when at least this far apart (a smaller gap is
    /// refused). Default 0.05 m.
    pub min_wall_thickness_metres: f64,
    /// ... and at most this far apart. Default 0.6 m.
    pub max_wall_thickness_metres: f64,
    /// Thickness of a wall seen from one side only. Default 0.2 m.
    pub default_wall_thickness_metres: f64,
    /// Faces must overlap along the wall by at least this share of the
    /// shorter face to pair. Default 0.5.
    pub min_wall_overlap_fraction: f64,
    /// Vertical faces shorter (horizontally) are not walls. Default 0.5 m.
    pub min_wall_length_metres: f64,
    /// Vertical faces lower than this are not walls. Default 1 m.
    pub min_wall_height_metres: f64,
    /// Horizontal planes smaller than this are not slabs. Default 1 m^2.
    pub min_slab_area_square_metres: f64,
    /// Thickness of a slab seen from one side only. Default 0.2 m.
    pub default_slab_thickness_metres: f64,
    /// A ceiling and the floor above pair when this close (and at least
    /// `minWallThicknessMetres` apart). Default 0.6 m.
    pub max_slab_thickness_metres: f64,
    /// Wall and column ends within this of a floor or ceiling extend to it;
    /// half of it decides which side of a horizontal plane walls stand on.
    /// Default 0.3 m.
    pub level_snap_metres: f64,
    /// A point inside the scanned space (model frame). Places single wall
    /// faces whose normal does not face the scanner, and decides floor or
    /// ceiling when no wall touches a horizontal plane. Default: the
    /// area-weighted mean of the plane centroids.
    pub interior_point: Option<[f64; 3]>,
}

impl Default for ScanProposalOptions {
    fn default() -> Self {
        Self {
            scan_to_model: [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.],
            schema: ProposalSchema::Ifc4,
            classification_angle_degrees: 10.,
            pairing_angle_degrees: 5.,
            min_wall_thickness_metres: 0.05,
            max_wall_thickness_metres: 0.6,
            default_wall_thickness_metres: 0.2,
            min_wall_overlap_fraction: 0.5,
            min_wall_length_metres: 0.5,
            min_wall_height_metres: 1.,
            min_slab_area_square_metres: 1.,
            default_slab_thickness_metres: 0.2,
            max_slab_thickness_metres: 0.6,
            level_snap_metres: 0.3,
            interior_point: None,
        }
    }
}

/// Validated options with derived constants.
#[derive(Debug, Clone)]
pub(crate) struct Params {
    pub schema: ProposalSchema,
    pub sin_class: f64,
    pub cos_class: f64,
    pub cos_pair: f64,
    pub min_thickness: f64,
    pub max_thickness: f64,
    pub wall_thickness: f64,
    pub min_overlap: f64,
    pub min_wall_length: f64,
    pub min_wall_height: f64,
    pub min_slab_area: f64,
    pub slab_thickness: f64,
    pub max_slab_thickness: f64,
    pub snap: f64,
    pub interior: Option<[f64; 3]>,
}

fn positive(value: f64, hi: f64) -> bool {
    value > 0. && value <= hi
}

/// `lo <= value <= hi`; false for NaN.
fn between(value: f64, lo: f64, hi: f64) -> bool {
    value >= lo && value <= hi
}

impl ScanProposalOptions {
    pub(crate) fn validate(&self) -> Result<Params, String> {
        let o = self;
        let fail = |what: &str| Err(format!("Scan proposal option {what}"));
        if !positive(o.classification_angle_degrees, 45.) || !positive(o.pairing_angle_degrees, 45.) {
            return fail("angles must be within (0, 45] degrees");
        }
        if !positive(o.min_wall_thickness_metres, 10.)
            || !between(o.max_wall_thickness_metres, o.min_wall_thickness_metres, 10.)
            || !positive(o.default_wall_thickness_metres, 10.)
            || !positive(o.default_slab_thickness_metres, 10.)
            || !between(o.max_slab_thickness_metres, o.min_wall_thickness_metres, 10.)
        {
            return fail("thicknesses must be within (0, 10] m with min <= max");
        }
        if !positive(o.min_wall_overlap_fraction, 1.) {
            return fail("minWallOverlapFraction must be within (0, 1]");
        }
        if !between(o.min_wall_length_metres, 0., 1e3)
            || !between(o.min_wall_height_metres, 0., 1e3)
            || !between(o.min_slab_area_square_metres, 0., 1e6)
            || !between(o.level_snap_metres, 0., 10.)
        {
            return fail("minimum sizes and levelSnapMetres must be finite and non-negative");
        }
        if o.interior_point.is_some_and(|p| p.iter().any(|v| !v.is_finite() || v.abs() > 1e12)) {
            return fail("interiorPoint must lie within 1e12 m");
        }
        let class = o.classification_angle_degrees.to_radians();
        Ok(Params {
            schema: o.schema,
            sin_class: class.sin(),
            cos_class: class.cos(),
            cos_pair: o.pairing_angle_degrees.to_radians().cos(),
            min_thickness: o.min_wall_thickness_metres,
            max_thickness: o.max_wall_thickness_metres,
            wall_thickness: o.default_wall_thickness_metres,
            min_overlap: o.min_wall_overlap_fraction,
            min_wall_length: o.min_wall_length_metres,
            min_wall_height: o.min_wall_height_metres,
            min_slab_area: o.min_slab_area_square_metres,
            slab_thickness: o.default_slab_thickness_metres,
            max_slab_thickness: o.max_slab_thickness_metres,
            snap: o.level_snap_metres,
            interior: o.interior_point,
        })
    }
}
