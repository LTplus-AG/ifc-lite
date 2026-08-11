// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

// ────────────────────────────────────────────────────────────────────────────
// 2D transform primitives. Floor-plan symbolic rendering uses a custom
// 2D-only transform. `compose_transforms` is ordinary affine composition —
// the child's translation IS carried through the parent's linear block, and
// the linear blocks multiply — so symbols orient and land correctly under a
// nested placement. (An earlier version of this comment claimed translations
// accumulated unrotated, which never matched the code.)
// `tz` is strictly additive along the chain and lets each primitive carry
// its storey elevation forward via `world_y`.
// ────────────────────────────────────────────────────────────────────────────

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
    pub(super) tx: f32,
    pub(super) ty: f32,
    pub(super) tz: f32,
    pub(super) m00: f32,
    pub(super) m01: f32,
    pub(super) m10: f32,
    pub(super) m11: f32,
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
    /// propagates additively so consumers test `f32::is_finite()` (#2256).
    pub(super) fn unresolved() -> Self {
        Self { tz: f32::NAN, ..Self::identity() }
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
    pub(super) fn scale(&self) -> f32 {
        (self.m00 * self.m11 - self.m01 * self.m10).abs().sqrt()
    }

    pub(super) fn transform_point(&self, x: f32, y: f32) -> (f32, f32) {
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
    unit_scale: f32,
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
    unit_scale: f32,
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
    unit_scale: f32,
) -> Transform2D {
    let is_3d = placement.ifc_type == IfcType::IfcAxis2Placement3D;

    let (tx, ty, tz) = match placement.get_ref(0) {
        Some(loc_ref) => match decoder.decode_by_id(loc_ref) {
            Ok(loc) if loc.ifc_type == IfcType::IfcCartesianPoint => {
                let coords = loc
                    .get(0)
                    .and_then(|a| a.as_list())
                    .map(|l| l.to_vec())
                    .unwrap_or_default();
                let raw_x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let raw_y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let raw_z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                (raw_x * unit_scale, raw_y * unit_scale, raw_z * unit_scale)
            }
            _ => return Transform2D::unresolved(), // dangling ref/wrong type: mandatory Location (#2355)
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
                    let dx = ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0) as f32;
                    let dy = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                    let dz = ratios.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
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

/// Parse `IfcCartesianTransformationOperator2D` / `…3D` for `IfcMappedItem`
/// targets: translation, the full 2x2 linear block (rotation, optional
/// reflection, and the uniform `Scale`, attr 3).
///
/// Axis1 (attr 0) gives the local X direction. Axis2 (attr 1) is normally
/// just the right-handed perpendicular of Axis1 and is IGNORED in that case,
/// keeping bit-identical output for the (overwhelmingly common) non-mirroring
/// case. A supplied Axis2 that DISAGREES with the perpendicular — a mirroring
/// MappingTarget, the frame `#1994` is about — is honoured instead, exactly
/// mirroring how `router/transforms/operator.rs`'s 3D path derives handedness
/// from Axis2 vs. `Axis3 × Axis1`. Per-axis (`…nonUniform`) scales are still
/// not read here (only the uniform `Scale`); that gap is unchanged from
/// before and is a separate concern from the mirroring this fixes.
///
/// Axis3 (attr 4 on `IfcCartesianTransformationOperator3D`) is deliberately
/// NOT consulted, and cannot matter here. A 3D operator's matrix has Axis1,
/// Axis2 and Axis3 as its columns, so the plan projection — rows x,y of the
/// first two columns — is a function of Axis1 and Axis2 alone; Axis3 lives
/// entirely in the discarded third column. Concretely, a reflection through
/// the XY plane (Axis3 = −Z, default Axis1/Axis2) has 3D `det = −1` while its
/// plan submatrix is the identity with `det = +1`: mirroring an object
/// vertically does not mirror its footprint, and leaving the plan symbol
/// unmirrored is the correct answer, not an oversight. A tilted, non-axis
/// aligned Axis3 is outside what a plan projection represents at all.
pub(super) fn parse_cartesian_transformation_operator(
    operator: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
) -> Transform2D {
    // attr 2 = LocalOrigin (IfcCartesianPoint).
    let (tx, ty) = match operator.get_ref(2) {
        Some(loc_ref) => match decoder.decode_by_id(loc_ref) {
            Ok(loc) if loc.ifc_type == IfcType::IfcCartesianPoint => {
                let coords = loc
                    .get(0)
                    .and_then(|a| a.as_list())
                    .map(|l| l.to_vec())
                    .unwrap_or_default();
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                (x * unit_scale, y * unit_scale)
            }
            _ => (0.0, 0.0),
        },
        None => (0.0, 0.0),
    };

    // Scale (attr 3), defaulting to 1.0 when absent/null or non-finite (the same
    // NaN guard the 3D operator parser applies, so a malformed Scale can never
    // poison a coordinate). The MAGNITUDE is taken: a negative Scale is a
    // uniform-reflection convention some exporters use, distinct from the
    // Axis2 mirroring this function now derives; folding its sign in here too
    // is out of scope for #1994 (unchanged from before this fix).
    let raw_scale = operator.get(3).and_then(|v| v.as_float()).unwrap_or(1.0) as f32;
    let scale = if raw_scale.is_finite() { raw_scale.abs() } else { 1.0 };

    // Axis1 (attr 0) gives the X direction for 2D / 3D operators.
    let x_axis = match operator.get_ref(0) {
        Some(ax_ref) => match decoder.decode_by_id(ax_ref) {
            Ok(ax) if ax.ifc_type == IfcType::IfcDirection => {
                let ratios = ax
                    .get(0)
                    .and_then(|a| a.as_list())
                    .map(|l| l.to_vec())
                    .unwrap_or_default();
                let dx = ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0) as f32;
                let dy = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let len = (dx * dx + dy * dy).sqrt();
                if len > 0.0001 {
                    (dx / len, dy / len)
                } else {
                    (1.0, 0.0)
                }
            }
            _ => (1.0, 0.0),
        },
        None => (1.0, 0.0),
    };

    // Right-handed perpendicular of Axis1 (the default Y when Axis2 is
    // absent or agrees with it): rotating (dx, dy) by +90°.
    let default_y = (-x_axis.1, x_axis.0);

    // Axis2 (attr 1): only consulted when it DISAGREES with `default_y`.
    let y_axis = match operator.get_ref(1) {
        Some(ax_ref) => match decoder.decode_by_id(ax_ref) {
            Ok(ax) if ax.ifc_type == IfcType::IfcDirection => {
                let ratios = ax
                    .get(0)
                    .and_then(|a| a.as_list())
                    .map(|l| l.to_vec())
                    .unwrap_or_default();
                let ex = ratios.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let ey = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(1.0) as f32;
                // Project onto the perpendicular of x_axis (Gram-Schmidt),
                // matching the 3D path's orthogonalization.
                let dot = ex * x_axis.0 + ey * x_axis.1;
                let px = ex - dot * x_axis.0;
                let py = ey - dot * x_axis.1;
                let len = (px * px + py * py).sqrt();
                if len > 0.0001 {
                    let proj = (px / len, py / len);
                    let agreement = proj.0 * default_y.0 + proj.1 * default_y.1;
                    if agreement < 1.0 - 1e-6 {
                        proj
                    } else {
                        default_y
                    }
                } else {
                    default_y
                }
            }
            _ => default_y,
        },
        None => default_y,
    };

    Transform2D {
        tx,
        ty,
        tz: 0.0,
        m00: x_axis.0 * scale,
        m10: x_axis.1 * scale,
        m01: y_axis.0 * scale,
        m11: y_axis.1 * scale,
    }
}

/// Resolve a circle / ellipse Position → Location → (x, y, z) in metres.
pub(super) fn circle_center(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
) -> (f32, f32, f32) {
    let Some(pos_ref) = item.get_ref(0) else {
        return (0.0, 0.0, 0.0);
    };
    let Ok(placement) = decoder.decode_by_id(pos_ref) else {
        return (0.0, 0.0, 0.0);
    };
    let Some(loc_ref) = placement.get_ref(0) else {
        return (0.0, 0.0, 0.0);
    };
    let Ok(loc) = decoder.decode_by_id(loc_ref) else {
        return (0.0, 0.0, 0.0);
    };
    let Some(coords) = loc.get(0).and_then(|a| a.as_list()) else {
        return (0.0, 0.0, 0.0);
    };
    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
    let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
    (x, y, z)
}
