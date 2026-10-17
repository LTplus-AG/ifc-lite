// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one home for placement frames and the `ObjectPlacement` chain (F3b).
//!
//! - [`Axis2Placement`] / [`Axis1Placement`]: the attributes of an
//!   `IfcAxis2Placement3D` / `IfcAxis1Placement`, read once.
//! - [`build_axis2_matrix`]: the only orthonormalisation of a frame.
//! - [`resolve_chain`] / [`resolve_object_placement`]: the world transform of
//!   a placement, walked iteratively up `PlacementRelTo` with a visited set
//!   and no depth cap (D27), memoised on the decoder.
//! - [`chain`] / [`validate_chain`]: the same walk without transforms, for
//!   consumers that check a chain against their own rules.
//!
//! Results are **unscaled** (file units, the memo's unit); the caller scales.

mod chain;
mod chain_walk;
mod grid;
mod grid_frame;
mod leaf;
pub(crate) mod linear;
mod validate;

#[cfg(test)]
mod chain_tests;
#[cfg(test)]
mod grid_tests;
#[cfg(test)]
mod linear_tests;
#[cfg(test)]
mod mod_tests;

pub use chain::{chain, resolve_chain, resolve_object_placement, Link, LinkKind};
pub use validate::{validate_chain, ChainPolicy};

use crate::math::tol;
use crate::axis_projection::perpendicular_x_axis;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::{Matrix4, Point3, Vector3};

/// Why a placement could not be resolved.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum PlacementError {
    /// `PlacementRelTo` loops back on itself; `at` is the repeated placement.
    #[error("placement chain is cyclic at #{at}")]
    Cyclic { at: u32 },
    /// A record of the wrong type in a placement slot.
    #[error("#{at}: unsupported placement record {found}")]
    Unsupported { at: u32, found: IfcType },
    /// A mandatory attribute (`$` or absent) is missing.
    #[error("#{at}: missing {attr}")]
    Missing { at: u32, attr: &'static str },
    /// [`validate_chain`] only: the chain breaks the caller's [`ChainPolicy`].
    /// A consumer's limit, not bad input.
    #[error("#{at}: {rule}")]
    Policy { at: u32, rule: &'static str },
    /// A dangling id or a core decode refusal.
    #[error(transparent)]
    Decode(#[from] ifc_lite_core::Error),
}

impl From<PlacementError> for crate::Error {
    fn from(error: PlacementError) -> Self {
        match error {
            PlacementError::Decode(core) => Self::CoreError(core),
            other => Self::GeometryError(other.to_string()),
        }
    }
}

/// `Result` of the placement readers.
pub type PlacementResult<T> = std::result::Result<T, PlacementError>;

const Z: [f64; 3] = [0.0, 0.0, 1.0];
const X: [f64; 3] = [1.0, 0.0, 0.0];

/// The attributes of an `IfcAxis2Placement3D`: raw `Axis` and `RefDirection`
/// ratios (`None` when `$`), orthonormalised only by [`Self::matrix`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Axis2Placement {
    pub location: [f64; 3],
    pub axis: Option<[f64; 3]>,
    pub ref_direction: Option<[f64; 3]>,
}

impl Axis2Placement {
    /// Read the attribute layout of an `IfcAxis2Placement3D`: Location (0),
    /// Axis (1), RefDirection (2). The caller selected the type.
    pub fn read_3d(placement: &DecodedEntity, decoder: &mut EntityDecoder) -> PlacementResult<Self> {
        Ok(Self {
            location: leaf::point(placement, decoder, 0)?,
            axis: leaf::optional_direction(placement, decoder, 1)?,
            ref_direction: leaf::optional_direction(placement, decoder, 2)?,
        })
    }

    /// [`Self::read_3d`] on a record that must be an `IfcAxis2Placement3D`.
    pub fn read(placement: &DecodedEntity, decoder: &mut EntityDecoder) -> PlacementResult<Self> {
        match &placement.ifc_type {
            IfcType::IfcAxis2Placement3D => Self::read_3d(placement, decoder),
            found => Err(PlacementError::Unsupported { at: placement.id, found: found.clone() }),
        }
    }

    /// Decode `id`, then [`Self::read`].
    pub fn read_id(id: u32, decoder: &mut EntityDecoder) -> PlacementResult<Self> {
        let placement = decoder.decode_by_id(id)?;
        Self::read(&placement, decoder)
    }

    /// The local-to-parent frame: [`build_axis2_matrix`] with the IFC defaults
    /// (+Z, +X) for an absent Axis or RefDirection.
    pub fn matrix(&self) -> Matrix4<f64> {
        build_axis2_matrix(
            Point3::from(self.location),
            Vector3::from(self.axis.unwrap_or(Z)),
            Vector3::from(self.ref_direction.unwrap_or(X)),
        )
    }
}

/// The attributes of an `IfcAxis1Placement`: Location (0), Axis (1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Axis1Placement {
    pub location: [f64; 3],
    pub axis: Option<[f64; 3]>,
}

impl Axis1Placement {
    pub fn read(placement: &DecodedEntity, decoder: &mut EntityDecoder) -> PlacementResult<Self> {
        if placement.ifc_type != IfcType::IfcAxis1Placement {
            return Err(PlacementError::Unsupported { at: placement.id, found: placement.ifc_type.clone() });
        }
        Ok(Self {
            location: leaf::point(placement, decoder, 0)?,
            axis: leaf::optional_direction(placement, decoder, 1)?,
        })
    }

    /// The Axis, or the IFC derived default +Z. A consumer whose WR rules the
    /// default out refuses on `axis == None` itself.
    pub fn axis_or_ifc_default(&self) -> [f64; 3] {
        self.axis.unwrap_or(Z)
    }
}

/// Orthonormalize a placement's raw axes + location into a column-major 4×4
/// transform (columns = world-space local X, Y, Z, then translation).
///
/// `z_axis` is the raw Axis (local +Z), `x_axis` the raw RefDirection (local
/// +X); both are normalized here. This is the only orthonormalisation of a
/// frame in the crate and the single home for the degenerate-axis fallback:
/// when RefDirection is parallel to Axis the projected X collapses, so instead
/// of normalizing a zero vector (a NaN matrix) a deterministic perpendicular
/// direction is picked. The math is the canonical Gram–Schmidt (normalize Z,
/// project RefDirection onto the plane ⟂ Z, then Y = Z × X).
pub(crate) fn build_axis2_matrix(
    location: Point3<f64>,
    z_axis: Vector3<f64>,
    x_axis: Vector3<f64>,
) -> Matrix4<f64> {
    // A malformed IfcDirection((0,0,0)) as Axis/RefDirection would make a bare
    // normalize() emit NaN (0/0) and poison the whole placement matrix. A zero
    // Axis falls back to +Z; a zero RefDirection routes into the
    // parallel-axis fallback below.
    let z_axis_final = z_axis
        .try_normalize(tol::AXIS_MIN_LEN)
        .unwrap_or_else(|| Vector3::new(0.0, 0.0, 1.0));
    let x_axis_normalized = x_axis
        .try_normalize(tol::AXIS_MIN_LEN)
        .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));

    let x_axis_final = perpendicular_x_axis(z_axis_final, x_axis_normalized);

    // Y axis is cross product of Z and X (right-hand rule: Y = Z × X)
    let y_axis = z_axis_final.cross(&x_axis_final).normalize();

    // Columns represent world-space directions of local axes
    let mut transform = Matrix4::identity();
    transform[(0, 0)] = x_axis_final.x;
    transform[(1, 0)] = x_axis_final.y;
    transform[(2, 0)] = x_axis_final.z;
    transform[(0, 1)] = y_axis.x;
    transform[(1, 1)] = y_axis.y;
    transform[(2, 1)] = y_axis.z;
    transform[(0, 2)] = z_axis_final.x;
    transform[(1, 2)] = z_axis_final.y;
    transform[(2, 2)] = z_axis_final.z;
    transform[(0, 3)] = location.x;
    transform[(1, 3)] = location.y;
    transform[(2, 3)] = location.z;

    transform
}
