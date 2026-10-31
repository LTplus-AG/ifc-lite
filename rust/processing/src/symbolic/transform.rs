// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_geometry::placement::{self, Axis2Placement, PlacementError};
use nalgebra::Matrix4;

#[path = "operator.rs"]
mod operator;
pub(super) use operator::resolve_mapping_target;

// ────────────────────────────────────────────────────────────────────────────
// Symbolic transforms retain the full 3D affine frame until a primitive is
// projected to plan XY. Projecting a product and its conic Position separately
// loses terms that can cancel their tilts (#7779). Unknown `tz` remains the
// #2256 elevation sentinel; it does not poison otherwise known plan coordinates.
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

/// A 3D affine frame for plan symbols, including reflected XY operators.
/// `transform_point` projects a local XY-plane point only at final output;
/// composition retains all three axes so opposing tilts cancel in world space.
#[derive(Clone, Copy, Debug)]
pub(super) struct Transform2D {
    pub(super) tx: f64,
    pub(super) ty: f64,
    pub(super) tz: f64,
    pub(super) m00: f64,
    pub(super) m01: f64,
    pub(super) m10: f64,
    pub(super) m11: f64,
    pub(super) m02: f64,
    pub(super) m12: f64,
    pub(super) m20: f64,
    pub(super) m21: f64,
    pub(super) m22: f64,
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
            m02: 0.0,
            m12: 0.0,
            m20: 0.0,
            m21: 0.0,
            m22: 1.0,
        }
    }

    /// `tz: NaN` = unresolved (vs. `identity()`'s legitimate zero); NaN
    /// propagates additively so consumers test `is_finite()` (#2256).
    pub(super) fn unresolved() -> Self {
        Self {
            tz: f64::NAN,
            ..Self::identity()
        }
    }

    /// A placement refused by input admission (#7678, D15): it holds a REAL
    /// the double range cannot represent (`1.E400`). Every component is NaN,
    /// so the finite-point guards DROP the symbol, as the infinity it decoded
    /// to before did. Not [`Self::unresolved`]: #2256's keep-at-the-origin
    /// rule is for a placement that is genuinely missing, not one refused.
    pub(super) fn refused() -> Self {
        Self {
            tx: f64::NAN,
            ty: f64::NAN,
            tz: f64::NAN,
            ..Self::identity()
        }
    }

    /// Poison a stopped frame while retaining its exact source-owned error.
    /// The accumulator rejects it and discards staged output, not input records.
    pub(super) fn stopped(stop: ifc_lite_geometry::resource::ProgramStop) -> Self {
        ifc_lite_geometry::resource::stop(stop);
        Self::refused()
    }

    /// The transform for a placement record that failed to decode:
    /// [`Self::refused`] when input admission refused it, otherwise
    /// [`Self::unresolved`] (#2256).
    pub(super) fn undecodable(error: &ifc_lite_core::Error) -> Self {
        if is_refused(error) {
            Self::refused()
        } else {
            Self::unresolved()
        }
    }

    /// A world frame (file units, the chain's unscaled
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
            m02: m[(0, 2)],
            m12: m[(1, 2)],
            m20: m[(2, 0)],
            m21: m[(2, 1)],
            m22: m[(2, 2)],
        }
    }

    /// The transform for a placement that could not be read (D30): input
    /// admission, a malformed leaf or a missing mandatory attribute drops the
    /// symbol ([`Self::refused`], D15). Execution stops preserve their source
    /// authority and poison the frame without counting malformed input. Other
    /// errors (dangling, wrong type, cycle) remain unresolved (#2256, until C5).
    pub(super) fn from_placement_error(error: &PlacementError) -> Self {
        if let PlacementError::ProgramStopped(stop) = error {
            return Self::stopped(*stop);
        }
        if error.is_admission_refusal() {
            Self::refused()
        } else {
            Self::unresolved()
        }
    }

    /// Whether the linear block preserves circles: equal nonzero column
    /// lengths and perpendicular columns, allowing roundoff in rigid chains.
    /// Reflections are similarities too; rank-one projections are not.
    pub(super) fn is_similarity(&self) -> bool {
        let x2 = self.m00 * self.m00 + self.m10 * self.m10;
        let y2 = self.m01 * self.m01 + self.m11 * self.m11;
        let dot = self.m00 * self.m01 + self.m10 * self.m11;
        let size = x2.max(y2);
        size.is_finite()
            && size > 0.0
            && (x2 - y2).abs() <= size * 1e-12
            && dot.abs() <= size * 1e-12
    }

    /// Uniform magnitude for similarities. Otherwise this is only an
    /// area-equivalent scale (retained for the scalar text-height convention).
    /// Conic geometry must sample its transformed points instead (#7779).
    pub(super) fn scale(&self) -> f64 {
        (self.m00 * self.m11 - self.m01 * self.m10).abs().sqrt()
    }

    pub(super) fn transform_point(&self, x: f64, y: f64) -> (f64, f64) {
        let rx = self.m00 * x + self.m01 * y;
        let ry = self.m10 * x + self.m11 * y;
        (rx + self.tx, ry + self.ty)
    }

    /// Project a vertex in metres through the same full frame as a conic's
    /// Position. Elevation is the transformed first vertex, not local Z plus
    /// the frame's translation (#7914).
    pub(super) fn transform_point3(&self, x: f64, y: f64, z: f64) -> (f64, f64, f64) {
        let rx = self.m00 * x + self.m01 * y + self.m02 * z;
        let ry = self.m10 * x + self.m11 * y + self.m12 * z;
        let rz = self.m20 * x + self.m21 * y + self.m22 * z;
        (rx + self.tx, ry + self.ty, rz + self.tz)
    }

    /// The existing symbolic coordinate-list policy, shared by polyline,
    /// indexed-curve and fill consumers. Scale each coordinate exactly once
    /// before applying the frame; absent Z promotes a 2D point to z=0.
    pub(super) fn transform_coordinates(
        &self,
        coords: &[AttributeValue],
        unit_scale: f64,
    ) -> (f64, f64, f64) {
        let [x, y, z] = std::array::from_fn(|index| {
            coords
                .get(index)
                .and_then(|value| value.as_float())
                .unwrap_or(0.0)
                * unit_scale
        });
        self.transform_point3(x, y, z)
    }
}

/// Compose in 3D: `a * b`, applying `b` first, before plan projection.
pub(super) fn compose_transforms(a: &Transform2D, b: &Transform2D) -> Transform2D {
    // #2256: unresolved elevation alone keeps the symbol at its known XY.
    // A refused placement poisons tx/ty too and still drops at the finite guard.
    let bz = if b.tz.is_nan() { 0.0 } else { b.tz };
    let tz = if a.tz.is_nan() || b.tz.is_nan() {
        f64::NAN
    } else {
        a.m20 * b.tx + a.m21 * b.ty + a.m22 * bz + a.tz
    };
    Transform2D {
        tx: a.m00 * b.tx + a.m01 * b.ty + a.m02 * bz + a.tx,
        ty: a.m10 * b.tx + a.m11 * b.ty + a.m12 * bz + a.ty,
        tz,
        m00: a.m00 * b.m00 + a.m01 * b.m10 + a.m02 * b.m20,
        m01: a.m00 * b.m01 + a.m01 * b.m11 + a.m02 * b.m21,
        m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02 * b.m22,
        m10: a.m10 * b.m00 + a.m11 * b.m10 + a.m12 * b.m20,
        m11: a.m10 * b.m01 + a.m11 * b.m11 + a.m12 * b.m21,
        m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12 * b.m22,
        m20: a.m20 * b.m00 + a.m21 * b.m10 + a.m22 * b.m20,
        m21: a.m20 * b.m01 + a.m21 * b.m11 + a.m22 * b.m21,
        m22: a.m20 * b.m02 + a.m21 * b.m12 + a.m22 * b.m22,
    }
}

/// Resolve a product's `ObjectPlacement` (attribute 5) into a 2D transform:
/// the shared 3D chain (`placement::resolve_chain`, memoised on the decoder and
/// walked without a depth cap), retained in 3D with translation in metres.
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

pub(super) fn resolve_context_transform(
    shape_rep: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f64,
) -> Transform2D {
    // ContextOfItems WCS: some Plan reps use a different coord
    // system than Body. Compose it in when present and non-trivial.
    // `ContextOfItems` (IfcRepresentation attr 0) and
    // `WorldCoordinateSystem` (IfcGeometricRepresentationContext
    // attr 4) are both MANDATORY, so a dangling ref or absent
    // attribute is malformed data, not a legitimate default —
    // `unresolved()` per #2352's convention. A resolved
    // `IfcGeometricRepresentationSubContext`, in contrast, derives
    // its WCS from `ParentContext` and legitimately does not store
    // one inline, so it alone stays `identity()`.
    // Named fixed slots preserve the existing malformed-reference recovery;
    // this extraction does not add a typed accessor's debug owner assertion.
    match shape_rep
        .get_ref(slot::IfcRepresentation::CONTEXT_OF_ITEMS.index())
    {
        Some(context_ref) => match decoder.decode_by_id(context_ref) {
            Ok(context) if context.ifc_type == IfcType::IfcGeometricRepresentationContext => {
                match context.get_ref(
                    slot::IfcGeometricRepresentationContext::WORLD_COORDINATE_SYSTEM.index(),
                ) {
                    Some(wcs_ref) => match decoder.decode_by_id(wcs_ref) {
                        Ok(wcs) => parse_axis2_placement_2d(&wcs, decoder, unit_scale),
                        Err(_) => Transform2D::unresolved(),
                    },
                    None => Transform2D::unresolved(),
                }
            }
            // SubContext inherits WCS from ParentContext — legitimately
            // has none inline (the wasm pipeline does the same).
            Ok(context) if context.ifc_type == IfcType::IfcGeometricRepresentationSubContext => {
                Transform2D::identity()
            }
            // Dangling context_ref, or a ref resolving to neither
            // Context nor SubContext: malformed data.
            _ => Transform2D::unresolved(),
        },
        None => Transform2D::unresolved(),
    }
}

/// Parse `IfcAxis2Placement3D` / `IfcAxis2Placement2D` to a 2D transform: the
/// canonical frame (`Axis2Placement`, so Axis is honoured and the degenerate
/// repair is the one `build_axis2_matrix` applies), retaining the full frame.
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
