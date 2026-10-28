// SPDX-License-Identifier: MPL-2.0
//! Decoder-only frames and convex right prisms for the M7 diagnostic oracle.
use super::super::{clipping::Edge, math::*};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
pub(super) type Frame = [f64; 16];
pub(super) struct Leaf {
    pub edges: Vec<Edge>,
    pub low: f64,
    pub high: f64,
    pub bbox: [f64; 6],
    pub curved: bool,
}
fn direction(d: &mut EntityDecoder<'_>, id: Option<u32>, default: [f64; 3]) -> Option<[f64; 3]> {
    match id {
        Some(id) => unit(d.direction3(id).ok()?),
        None => Some(default),
    }
}
fn columns(x: [f64; 3], y: [f64; 3], z: [f64; 3], p: [f64; 3]) -> Frame {
    [
        x[0], x[1], x[2], 0., y[0], y[1], y[2], 0., z[0], z[1], z[2], 0., p[0], p[1], p[2], 1.,
    ]
}
pub(super) fn axes(d: &mut EntityDecoder<'_>, id: Option<u32>) -> Option<Frame> {
    let Some(id) = id else { return Some(IDENTITY) };
    let e = d.decode_by_id(id).ok()?;
    let (z, x) = match e.ifc_type {
        IfcType::IfcAxis2Placement2D => (
            [0., 0., 1.],
            direction(
                d,
                e.ref_at(slot::IfcAxis2Placement2D::REF_DIRECTION),
                [1., 0., 0.],
            )?,
        ),
        IfcType::IfcAxis2Placement3D => (
            direction(d, e.ref_at(slot::IfcAxis2Placement3D::AXIS), [0., 0., 1.])?,
            direction(
                d,
                e.ref_at(slot::IfcAxis2Placement3D::REF_DIRECTION),
                [1., 0., 0.],
            )?,
        ),
        _ => return None,
    };
    let p = d.point3(e.ref_at(slot::IfcPlacement::LOCATION)?).ok()?;
    let y = unit(cross(z, x))?;
    Some(columns(cross(y, z), y, z, p))
}
pub(super) fn placement(d: &mut EntityDecoder<'_>, mut id: Option<u32>) -> Option<Frame> {
    let mut frame = IDENTITY;
    let mut seen = std::collections::BTreeSet::new();
    while let Some(next) = id {
        if !seen.insert(next) || seen.len() > 128 {
            return None;
        }
        let e = d.decode_by_id(next).ok()?;
        if e.ifc_type != IfcType::IfcLocalPlacement {
            return None;
        }
        frame = multiply(
            &axes(
                d,
                Some(e.ref_at(slot::IfcLocalPlacement::RELATIVE_PLACEMENT)?),
            )?,
            &frame,
        );
        id = e.ref_at(slot::IfcLocalPlacement::PLACEMENT_REL_TO);
    }
    Some(frame)
}
pub(super) fn mapping(
    d: &mut EntityDecoder<'_>,
    source: u32,
    target: u32,
) -> Option<(Frame, Vec<u32>)> {
    let map = d.decode_by_id(source).ok()?;
    if map.ifc_type != IfcType::IfcRepresentationMap {
        return None;
    }
    let origin = axes(
        d,
        Some(map.ref_at(slot::IfcRepresentationMap::MAPPING_ORIGIN)?),
    )?;
    let inverse = inverse_rigid(&origin);
    let e = d.decode_by_id(target).ok()?;
    if e.ifc_type != IfcType::IfcCartesianTransformationOperator3D {
        return None;
    }
    use slot::IfcCartesianTransformationOperator3D as Op;
    let x = direction(d, e.ref_at(Op::AXIS1), [1., 0., 0.])?;
    let y = direction(d, e.ref_at(Op::AXIS2), [0., 1., 0.])?;
    let z = direction(d, e.ref_at(Op::AXIS3), [0., 0., 1.])?;
    if dot(x, y).abs().max(dot(x, z).abs()).max(dot(y, z).abs()) > 1e-12 {
        return None;
    }
    let scale = e.real_at(Op::SCALE).unwrap_or(1.);
    if !scale.is_finite() || scale <= 0. {
        return None;
    }
    let target = columns(
        x.map(|a| a * scale),
        y.map(|a| a * scale),
        z.map(|a| a * scale),
        d.point3(e.ref_at(Op::LOCAL_ORIGIN)?).ok()?,
    );
    let rep = d
        .decode_by_id(map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION)?)
        .ok()?;
    if !rep.ifc_type.is_subtype_of(IfcType::IfcRepresentation) {
        return None;
    }
    Some((
        multiply(&target, &inverse),
        rep.ref_list_at(slot::IfcRepresentation::ITEMS)?,
    ))
}
pub(super) fn inverse_rigid(origin: &Frame) -> Frame {
    let mut inverse = IDENTITY;
    for i in 0..3 {
        for j in 0..3 {
            inverse[i + 4 * j] = origin[j + 4 * i];
        }
    }
    let p = vector(&inverse, [-origin[12], -origin[13], -origin[14]]);
    inverse[12..15].copy_from_slice(&p);
    inverse
}
pub(super) fn leaf(d: &mut EntityDecoder<'_>, id: u32, frame: &Frame) -> Option<Leaf> {
    let e = d.decode_by_id(id).ok()?;
    use slot::IfcExtrudedAreaSolid as Solid;
    let solid = multiply(frame, &axes(d, e.ref_at(Solid::POSITION))?);
    let axis = vector(
        &solid,
        unit(d.direction3(e.ref_at(Solid::EXTRUDED_DIRECTION)?).ok()?)?,
    );
    if axis[2] == 0. || axis[0].abs().max(axis[1].abs()) > axis[2].abs() * 1e-12 {
        return None;
    }
    let depth = e.real_at(Solid::DEPTH)?;
    if !depth.is_finite() || depth <= 0. {
        return None;
    }
    let profile = d.decode_by_id(e.ref_at(Solid::SWEPT_AREA)?).ok()?;
    if !matches!(
        profile.ifc_type,
        IfcType::IfcRectangleProfileDef | IfcType::IfcCircleProfileDef
    ) {
        return None;
    }
    let frame = multiply(
        &solid,
        &axes(
            d,
            profile.ref_at(slot::IfcParameterizedProfileDef::POSITION),
        )?,
    );
    if frame[2].abs().max(frame[6].abs()) > 1e-12 {
        return None;
    }
    let point = |x, y| {
        let p = transform(&frame, [x, y, 0.]);
        [p[0], p[1]]
    };
    let edges = match profile.ifc_type {
        IfcType::IfcRectangleProfileDef => {
            let (a, b) = (
                profile.real_at(slot::IfcRectangleProfileDef::X_DIM)? / 2.,
                profile.real_at(slot::IfcRectangleProfileDef::Y_DIM)? / 2.,
            );
            if a <= 0. || b <= 0. {
                return None;
            }
            let ps = [point(-a, -b), point(a, -b), point(a, b), point(-a, b)];
            (0..4).map(|i| Edge::Line(ps[i], ps[(i + 1) % 4])).collect()
        }
        IfcType::IfcCircleProfileDef => {
            let r = profile.real_at(slot::IfcCircleProfileDef::RADIUS)?;
            if !r.is_finite() || r <= 0. {
                return None;
            }
            vec![Edge::Arc {
                c: point(0., 0.),
                u: [frame[0] * r, frame[1] * r],
                v: [frame[4] * r, frame[5] * r],
                a: 0.,
                sweep: std::f64::consts::TAU,
            }]
        }
        _ => return None,
    };
    let low = frame[14].min(frame[14] + axis[2] * depth);
    let high = frame[14].max(frame[14] + axis[2] * depth);
    let mut bbox = [
        f64::INFINITY,
        f64::INFINITY,
        low,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
        high,
    ];
    for edge in &edges {
        match edge {
            Edge::Line(a, b) => {
                for p in [a, b] {
                    extend_bbox(&mut bbox, [p[0], p[1], low]);
                }
            }
            Edge::Arc { c, u, v, .. } => {
                for sign in [-1., 1.] {
                    extend_bbox(
                        &mut bbox,
                        [
                            c[0] + sign * u[0].hypot(v[0]),
                            c[1] + sign * u[1].hypot(v[1]),
                            low,
                        ],
                    );
                }
            }
        }
    }
    bbox.iter().all(|x| x.is_finite()).then_some(Leaf {
        edges,
        low,
        high,
        bbox,
        curved: profile.ifc_type == IfcType::IfcCircleProfileDef,
    })
}

/// A product's world frame and the item ids of its `Body` representations.
/// Not an IfcProduct, an unplaceable placement or a missing representation
/// list is `None`; a product with no `Body` item yields an empty list.
pub(super) fn body_items(
    d: &mut EntityDecoder<'_>,
    product: &DecodedEntity,
) -> Option<(Frame, Vec<u32>)> {
    if !product.ifc_type.is_subtype_of(IfcType::IfcProduct) {
        return None;
    }
    let world = placement(d, product.ref_at(slot::IfcProduct::OBJECT_PLACEMENT))?;
    let shape = d
        .decode_by_id(product.ref_at(slot::IfcProduct::REPRESENTATION)?)
        .ok()?;
    if !shape
        .ifc_type
        .is_subtype_of(IfcType::IfcProductRepresentation)
    {
        return None;
    }
    let mut items = Vec::new();
    for id in shape.ref_list_at(slot::IfcProductDefinitionShape::REPRESENTATIONS)? {
        let rep = d.decode_by_id(id).ok()?;
        if !rep.ifc_type.is_subtype_of(IfcType::IfcRepresentation)
            || rep.string_at(slot::IfcRepresentation::REPRESENTATION_IDENTIFIER) != Some("Body")
        {
            continue;
        }
        items.extend(rep.ref_list_at(slot::IfcRepresentation::ITEMS)?);
    }
    Some((world, items))
}
