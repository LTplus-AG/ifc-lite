// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{DecodedEntity, EntityDecoder};
use ifc_lite_geometry::placement::{self, Axis2Placement, PlacementError};
use nalgebra::Matrix4;

#[path = "operator.rs"]
mod operator;
pub(super) use operator::parse_cartesian_transformation_operator;

// ────────────────────────────────────────────────────────────────────────────
// 2D transform primitives. Floor-plan symbolic rendering uses a custom
// 2D-only transform. `compose_transforms` is ordinary affine composition —
// the child's translation IS carried through the parent's linear block, and
// the linear blocks multiply — so symbols orient and land correctly under a
// nested placement. (An earlier version of this comment claimed translations
// accumulated unrotated, which never matched the code.)
// `tz` is strictly additive along the chain and lets each primitive carry
// its storey elevation forward via `world_y`.
//
// All of it is f64 (#7684): a georeferenced placement or coordinate is read,
// composed and re-based in f64, and only `RenderFrameRebase` casts the small
// re-based result to the f32 the primitives carry.
// ────────────────────────────────────────────────────────────────────────────

/// Whether a decode failed because input admission refused the record (#7678).
pub(super) fn is_refused(error: &ifc_lite_core::Error) -> bool {
    matches!(error, ifc_lite_core::Error::UnrepresentableReal(_))
}

/// Push a plan-space `(x, y)` pair onto a point buffer, but only if BOTH
/// components are finite. STEP REALs are not guaranteed finite — a
/// hand-edited or malformed file can carry `1.E400`, which parses to
/// infinity and then propagates through `transform_point` /
/// `RenderFrameRebase::plan` into NaN/Inf; a finite f64 past f32's range
/// becomes infinity at the plan cast. This is the single chokepoint for
/// that guard: `items.rs`'s polyline/indexed-poly-curve/ellipse extraction
/// and `fill.rs`'s boundary-ring extraction both call this instead of
/// pushing directly, so the two paths cannot drift apart the way they did
/// before (fill.rs pushed unguarded coordinates while items.rs did not).
/// Returns `true` if the point was kept.
pub(super) fn push_finite_point(points: &mut Vec<f32>, x: f32, y: f32) -> bool {
    if x.is_finite() && y.is_finite() {
        points.push(x);
        points.push(y);
        true
    } else {
        false
    }
}

/// A full 2D AFFINE transform: an arbitrary 2x2 linear block (`m00, m01, m10,
/// m11`) plus translation. Unlike the `(cos_theta, sin_theta)` similarity this
/// replaced, the 2x2 CAN carry a reflection, so a mirroring `IfcMappedItem`
/// MappingTarget (an `Axis2` that disagrees with the right-handed frame derived
/// from `Axis1`) now draws its plan symbols mirrored, matching the 3D mesh path
/// (`router/transforms/operator.rs`). Column 0 (`m00, m10`) is the local X axis
/// image, column 1 (`m01, m11`) is the local Y axis image: `transform_point`
/// maps `(x, y) -> x * column0 + y * column1 + translation`. #1994 #1985
#[derive(Clone, Copy, Debug)]
pub(super) struct Transform2D {
    pub(super) tx: f64,
    pub(super) ty: f64,
    pub(super) tz: f64,
    pub(super) m00: f64,
    pub(super) m01: f64,
    pub(super) m10: f64,
    pub(super) m11: f64,
}

impl Transform2D {
    pub(super) fn identity() -> Self {
        Self {
            tx: 0.0,
            ty: 0.0,
            tz: 0.0,
            m00: 1.0,
            m01: 0.0,
            m10: 0.0,
            m11: 1.0,
        }
    }

    /// `tz: NaN` = unresolved (vs. `identity()`'s legitimate zero); NaN
    /// propagates additively so consumers test `is_finite()` (#2256).
    pub(super) fn unresolved() -> Self {
        Self { tz: f64::NAN, ..Self::identity() }
    }

    /// A placement refused by input admission (#7678, D15): it holds a REAL
    /// the double range cannot represent (`1.E400`). Every component is NaN,
    /// so the finite-point guards DROP the symbol, as the infinity it decoded
    /// to before did. Not [`Self::unresolved`]: #2256's keep-at-the-origin
    /// rule is for a placement that is genuinely missing, not one refused.
    pub(super) fn refused() -> Self {
        Self { tx: f64::NAN, ty: f64::NAN, tz: f64::NAN, ..Self::identity() }
    }

    /// The transform for a placement record that failed to decode:
    /// [`Self::refused`] when input admission refused it, otherwise
    /// [`Self::unresolved`] (#2256).
    pub(super) fn undecodable(error: &ifc_lite_core::Error) -> Self {
        if is_refused(error) { Self::refused() } else { Self::unresolved() }
    }

    /// The XY block of a world frame (file units, the chain's unscaled
    /// matrix), with the translation scaled to metres. The memo stays unscaled
    /// so readers with different unit contexts share it (F3b §4), which makes
    /// this scale the composed translation once instead of each level's.
    pub(super) fn from_matrix_xy(m: &Matrix4<f64>, unit_scale: f64) -> Self {
        Self {
            tx: m[(0, 3)] * unit_scale,
            ty: m[(1, 3)] * unit_scale,
            tz: m[(2, 3)] * unit_scale,
            m00: m[(0, 0)],
            m01: m[(0, 1)],
            m10: m[(1, 0)],
            m11: m[(1, 1)],
        }
    }

    /// The transform for a placement that could not be read (D30): input
    /// admission, a malformed leaf or a missing mandatory attribute drops the
    /// symbol ([`Self::refused`], D15); every other error (dangling, wrong
    /// type, cycle) keeps it at the origin as [`Self::unresolved`] (#2256,
    /// until C5 decides).
    pub(super) fn from_placement_error(error: &PlacementError) -> Self {
        if error.is_admission_refusal() { Self::refused() } else { Self::unresolved() }
    }

    /// Scale factor carried by the linear block, as `sqrt(|det|)`. For the
    /// similarity transforms this codebase actually authors (pure rotation,
    /// uniform scale, or both) `|det| = scale^2` exactly, so this returns the
    /// same uniform scale the old `(cos, sin)` magnitude did. A mirroring
    /// transform has `det < 0`; `sqrt(|det|)` still recovers the magnitude,
    /// which is what every scalar consumer (radius, height, …) wants — a
    /// reflection has no separate "size", only orientation, and orientation
    /// is not representable as a scalar. 1.0 for a pure rotation.
    ///
    /// PRECONDITION: the linear block is orthogonal times a UNIFORM scale.
    /// The constructors guarantee that for the placements plan symbols sit
    /// under — `parse_axis2_placement_2d` projects a Z-up frame, a pure
    /// rotation, and `parse_cartesian_transformation_operator` builds unit,
    /// mutually perpendicular columns scaled by one factor — and the property
    /// is closed under composition. A TILTED parent placement is projected
    /// foreshortened instead (its XY block is not orthogonal): `scale()` is
    /// then the geometric mean of the two in-plane scales, which is the
    /// right answer for a symbol seen at that tilt. If `Scale2` (non-uniform)
    /// is ever wired into this now-capable 2x2, `sqrt(|det|)` silently becomes
    /// the GEOMETRIC MEAN of the two axis scales and every scalar consumer
    /// below goes subtly wrong. Split the accessor before doing that. An
    /// `IfcMappedItem` MappingTarget's `Scale` folds in here (see
    /// `parse_cartesian_transformation_operator`), so SCALAR outputs that
    /// never pass through [`Self::transform_point`] — a circle's radius, an
    /// ellipse's semi-axes, a text height — must multiply by this or they
    /// stay authored-size while their positions move. #1985
    pub(super) fn scale(&self) -> f64 {
        (self.m00 * self.m11 - self.m01 * self.m10).abs().sqrt()
    }

    pub(super) fn transform_point(&self, x: f64, y: f64) -> (f64, f64) {
        let rx = self.m00 * x + self.m01 * y;
        let ry = self.m10 * x + self.m11 * y;
        (rx + self.tx, ry + self.ty)
    }
}

/// Compose two 2D transforms: `result = a * b` (apply `b` first, then `a`).
pub(super) fn compose_transforms(a: &Transform2D, b: &Transform2D) -> Transform2D {
    let m00 = a.m00 * b.m00 + a.m01 * b.m10;
    let m01 = a.m00 * b.m01 + a.m01 * b.m11;
    let m10 = a.m10 * b.m00 + a.m11 * b.m10;
    let m11 = a.m10 * b.m01 + a.m11 * b.m11;
    let rtx = a.m00 * b.tx + a.m01 * b.ty;
    let rty = a.m10 * b.tx + a.m11 * b.ty;
    Transform2D {
        tx: rtx + a.tx,
        ty: rty + a.ty,
        tz: a.tz + b.tz,
        m00,
        m01,
        m10,
        m11,
    }
}

/// Resolve a product's `ObjectPlacement` (attribute 5) into a 2D transform:
/// the shared 3D chain (`placement::resolve_chain`, memoised on the decoder and
/// walked without a depth cap), projected to XY and scaled to metres.
pub(super) fn resolve_object_placement(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f64,
) -> Transform2D {
    let Some(attr) = entity.get(5) else {
        return Transform2D::identity();
    };
    if attr.is_null() {
        return Transform2D::identity();
    }
    let placement = match decoder.resolve_ref(attr) {
        Ok(Some(placement)) => placement,
        Ok(None) => return Transform2D::unresolved(),
        Err(e) => return Transform2D::undecodable(&e), // refused, or dangling (#2256)
    };
    match placement::resolve_chain(&placement, decoder) {
        Ok(world) => Transform2D::from_matrix_xy(&world, unit_scale),
        Err(error) => Transform2D::from_placement_error(&error),
    }
}

/// Parse `IfcAxis2Placement3D` / `IfcAxis2Placement2D` to a 2D transform: the
/// canonical frame (`Axis2Placement`, so Axis is honoured and the degenerate
/// repair is the one `build_axis2_matrix` applies), projected to XY.
/// Floor-plan uses X-Y (Z is up) to match the section-cut coord system.
pub(super) fn parse_axis2_placement_2d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f64,
) -> Transform2D {
    match Axis2Placement::read(placement, decoder) {
        Ok(frame) => Transform2D::from_matrix_xy(&frame.matrix(), unit_scale),
        Err(error) => Transform2D::from_placement_error(&error),
    }
}

#[cfg(test)]
#[path = "transform_tests.rs"]
mod transform_tests;
