// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

// ────────────────────────────────────────────────────────────────────────────
// 2D transform primitives. Floor-plan symbolic rendering uses a custom
// 2D-only transform: translations accumulate directly (not rotated by parent
// rotations), but rotations DO accumulate so symbols orient correctly.
// `tz` is strictly additive along the chain and lets each primitive carry
// its storey elevation forward via `world_y`.
// ────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub(super) struct Transform2D {
    pub(super) tx: f32,
    pub(super) ty: f32,
    pub(super) tz: f32,
    pub(super) cos_theta: f32,
    pub(super) sin_theta: f32,
}

impl Transform2D {
    pub(super) fn identity() -> Self {
        Self {
            tx: 0.0,
            ty: 0.0,
            tz: 0.0,
            cos_theta: 1.0,
            sin_theta: 0.0,
        }
    }

    pub(super) fn transform_point(&self, x: f32, y: f32) -> (f32, f32) {
        let rx = x * self.cos_theta - y * self.sin_theta;
        let ry = x * self.sin_theta + y * self.cos_theta;
        (rx + self.tx, ry + self.ty)
    }
}

/// Compose two 2D transforms: `result = a * b` (apply `b` first, then `a`).
pub(super) fn compose_transforms(a: &Transform2D, b: &Transform2D) -> Transform2D {
    let combined_cos = a.cos_theta * b.cos_theta - a.sin_theta * b.sin_theta;
    let combined_sin = a.sin_theta * b.cos_theta + a.cos_theta * b.sin_theta;
    let rtx = b.tx * a.cos_theta - b.ty * a.sin_theta;
    let rty = b.tx * a.sin_theta + b.ty * a.cos_theta;
    Transform2D {
        tx: rtx + a.tx,
        ty: rty + a.ty,
        tz: a.tz + b.tz,
        cos_theta: combined_cos,
        sin_theta: combined_sin,
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
        return Transform2D::identity();
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
        return Transform2D::identity();
    }

    let parent_transform = match placement.get(0) {
        Some(parent_attr) if !parent_attr.is_null() => match decoder.resolve_ref(parent_attr) {
            Ok(Some(parent)) => {
                resolve_placement_for_symbolic(&parent, decoder, unit_scale, depth + 1)
            }
            _ => Transform2D::identity(),
        },
        _ => Transform2D::identity(),
    };

    let local_transform = match placement.get(1) {
        Some(rel_attr) if !rel_attr.is_null() => match decoder.resolve_ref(rel_attr) {
            Ok(Some(rel))
                if rel.ifc_type == IfcType::IfcAxis2Placement3D
                    || rel.ifc_type == IfcType::IfcAxis2Placement2D =>
            {
                parse_axis2_placement_2d(&rel, decoder, unit_scale)
            }
            _ => Transform2D::identity(),
        },
        _ => Transform2D::identity(),
    };

    let combined_cos = parent_transform.cos_theta * local_transform.cos_theta
        - parent_transform.sin_theta * local_transform.sin_theta;
    let combined_sin = parent_transform.sin_theta * local_transform.cos_theta
        + parent_transform.cos_theta * local_transform.sin_theta;

    let rotated_local_tx = local_transform.tx * parent_transform.cos_theta
        - local_transform.ty * parent_transform.sin_theta;
    let rotated_local_ty = local_transform.tx * parent_transform.sin_theta
        + local_transform.ty * parent_transform.cos_theta;

    Transform2D {
        tx: parent_transform.tx + rotated_local_tx,
        ty: parent_transform.ty + rotated_local_ty,
        tz: parent_transform.tz + local_transform.tz,
        cos_theta: combined_cos,
        sin_theta: combined_sin,
    }
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
            _ => (0.0, 0.0, 0.0),
        },
        None => (0.0, 0.0, 0.0),
    };

    // RefDirection lives at attr 2 for 3D, attr 1 for 2D.
    let ref_dir_attr = if is_3d {
        placement.get(2)
    } else {
        placement.get(1)
    };
    let (cos_theta, sin_theta) = match ref_dir_attr {
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

    Transform2D {
        tx,
        ty,
        tz,
        cos_theta,
        sin_theta,
    }
}

/// Parse `IfcCartesianTransformationOperator2D` / `…3D` for `IfcMappedItem`
/// targets. The wasm pipeline currently only honours translation +
/// uniform-scale rotation; we mirror that.
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

    // Axis1 (attr 0) gives the X direction for 2D / 3D operators.
    let (cos_theta, sin_theta) = match operator.get_ref(0) {
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

    Transform2D {
        tx,
        ty,
        tz: 0.0,
        cos_theta,
        sin_theta,
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
