// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

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
    /// Every constructor here guarantees that — `parse_axis2_placement_2d`
    /// builds a pure rotation, and `parse_cartesian_transformation_operator`
    /// builds unit, mutually perpendicular columns scaled by one factor — and
    /// the property is closed under composition. If `Scale2` (non-uniform)
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

/// Resolve a product's `ObjectPlacement` (attribute 5) into a 2D transform.
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
    let Ok(Some(placement)) = decoder.resolve_ref(attr) else {
        return Transform2D::unresolved(); // dangling ref: unresolvable, not zero (#2256)
    };
    resolve_placement_for_symbolic(&placement, decoder, unit_scale, 0)
}

/// Recursively resolve `IfcLocalPlacement` for 2D symbolic representations.
/// Mirrors the wasm pipeline's accumulation rule exactly.
fn resolve_placement_for_symbolic(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f64,
    depth: usize,
) -> Transform2D {
    if depth > 50 || placement.ifc_type != IfcType::IfcLocalPlacement {
        return Transform2D::unresolved(); // cycle guard/unsupported type (#2256)
    }

    let parent_transform = match placement.get(0) {
        Some(parent_attr) if !parent_attr.is_null() => match decoder.resolve_ref(parent_attr) {
            Ok(Some(parent)) => {
                resolve_placement_for_symbolic(&parent, decoder, unit_scale, depth + 1)
            }
            _ => Transform2D::unresolved(), // dangling/malformed (#2256)
        },
        _ => Transform2D::identity(), // absent/null: legitimate top of chain
    };

    let local_transform = match placement.get(1) {
        Some(rel_attr) if !rel_attr.is_null() => match decoder.resolve_ref(rel_attr) {
            Ok(Some(rel))
                if rel.ifc_type == IfcType::IfcAxis2Placement3D
                    || rel.ifc_type == IfcType::IfcAxis2Placement2D =>
            {
                parse_axis2_placement_2d(&rel, decoder, unit_scale)
            }
            _ => Transform2D::unresolved(), // dangling ref/wrong type (#2256)
        },
        _ => Transform2D::unresolved(), // mandatory attr absent (#2256)
    };

    // Same composition `compose_transforms` performs (parent applied after
    // local); kept as a direct call rather than a hand-inlined duplicate so
    // the two never drift on the linear-block representation again.
    compose_transforms(&parent_transform, &local_transform)
}

/// Parse `IfcAxis2Placement3D` / `IfcAxis2Placement2D` to a 2D transform.
/// Floor-plan uses X-Y (Z is up) to match the section-cut coord system.
pub(super) fn parse_axis2_placement_2d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f64,
) -> Transform2D {
    if placement.ifc_type != IfcType::IfcAxis2Placement3D
        && placement.ifc_type != IfcType::IfcAxis2Placement2D
    {
        // Wrong entity type wired into a placement slot (malformed data or
        // a dangling ref that happened to resolve to something else): the
        // 2D/3D branches below key attribute INDICES off `is_3d`, so
        // reading them on an unrelated entity type would silently produce
        // a fabricated transform rather than surface the mismatch. Treat
        // it as unresolved, matching every other malformed-data path in
        // this file (#2256's convention).
        return Transform2D::unresolved();
    }
    let is_3d = placement.ifc_type == IfcType::IfcAxis2Placement3D;

    let (tx, ty, tz) = match placement.get_ref(0) {
        Some(loc_ref) => match decoder.decode_by_id(loc_ref) {
            Ok(loc) if loc.ifc_type == IfcType::IfcCartesianPoint => {
                let coords = loc
                    .get(0)
                    .and_then(|a| a.as_list())
                    .map(|l| l.to_vec())
                    .unwrap_or_default();
                let raw_x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                let raw_y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                let raw_z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                (raw_x * unit_scale, raw_y * unit_scale, raw_z * unit_scale)
            }
            Err(e) => return Transform2D::undecodable(&e), // refused, or dangling (#2355)
            _ => return Transform2D::unresolved(), // wrong type: mandatory Location (#2355)
        },
        None => return Transform2D::unresolved(), // mandatory Location absent (#2355)
    };

    // RefDirection lives at attr 2 for 3D, attr 1 for 2D.
    let ref_dir_attr = if is_3d {
        placement.get(2)
    } else {
        placement.get(1)
    };
    let (dx, dy) = match ref_dir_attr {
        Some(attr) if !attr.is_null() => match attr.as_entity_ref() {
            Some(ref_dir_id) => match decoder.decode_by_id(ref_dir_id) {
                Ok(ref_dir) if ref_dir.ifc_type == IfcType::IfcDirection => {
                    let ratios = ref_dir
                        .get(0)
                        .and_then(|a| a.as_list())
                        .map(|l| l.to_vec())
                        .unwrap_or_default();
                    let dx = ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0);
                    let dy = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    let dz = ratios.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                    let len = (dx * dx + dy * dy).sqrt();
                    if len > 0.0001 {
                        (dx / len, dy / len)
                    } else if is_3d && dz.abs() > 0.0001 {
                        // RefDirection purely in Z (vertical) — local X
                        // points up/down, rotation is 0° in floor plan.
                        (1.0, 0.0)
                    } else {
                        (1.0, 0.0)
                    }
                }
                Err(e) if is_refused(&e) => return Transform2D::refused(),
                _ => (1.0, 0.0),
            },
            None => (1.0, 0.0),
        },
        _ => (1.0, 0.0),
    };

    // `IfcAxis2Placement2D` / `…3D` carry only ONE in-plane direction
    // (RefDirection); the Y axis is always the right-handed perpendicular —
    // there is no second direction attribute here that could disagree and
    // introduce a reflection, unlike `IfcCartesianTransformationOperator`'s
    // Axis1/Axis2 pair below.
    Transform2D {
        tx,
        ty,
        tz,
        m00: dx,
        m01: -dy,
        m10: dy,
        m11: dx,
    }
}

#[cfg(test)]
#[path = "transform_tests.rs"]
mod transform_tests;

/// Resolve the representation context and compose it with the product frame.
/// Kept separate from scan admission and publication checks.
pub(super) fn resolve_representation_transform(
    shape_rep: &DecodedEntity,
    placement_transform: Transform2D,
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
    let context_transform = match shape_rep.get_ref(slot::IfcRepresentation::CONTEXT_OF_ITEMS.index()) {
        Some(context_ref) => match decoder.decode_by_id(context_ref) {
            Ok(context) if context.ifc_type == IfcType::IfcGeometricRepresentationContext => {
                match context.get_ref(slot::IfcGeometricRepresentationContext::WORLD_COORDINATE_SYSTEM.index()) {
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
    };
    if context_transform.tx.abs() > 0.001
        || context_transform.ty.abs() > 0.001
        || context_transform.tz.abs() > 0.001
        || (context_transform.m00 - 1.0).abs() > 0.0001
        || context_transform.m01.abs() > 0.0001
        || context_transform.m10.abs() > 0.0001
        || (context_transform.m11 - 1.0).abs() > 0.0001
        || context_transform.tz.is_nan()
    {
        compose_transforms(&context_transform, &placement_transform)
    } else {
        placement_transform
    }
}
