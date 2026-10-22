// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcGridPlacement resolution (#883): locate the grid-axis intersection and orient it.

use super::chain_walk::GridCtx;
use super::grid_frame::GridPlacementLayout;
use super::{missing, sampled, unsupported, PlacementResult};
use crate::profiles::ProfileProcessor;
use crate::{Point2, Point3, TessellationQuality, Vector2, Vector3};
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

/// The grid-local frame of an `IfcGridPlacement`: the grid-axis intersection
/// of `PlacementLocation`, oriented by the optional `PlacementRefDirection`.
/// Malformed structure or parallel axes refuse the placement (D30).
///
/// The placement's world is `grid frame * this`, where the grid frame is
///   • IFC4X1+: `PlacementRelTo` (the grid's own placement), composed like
///     IfcLocalPlacement's parent;
///   • IFC2X3/IFC4 (no `PlacementRelTo`): the `ObjectPlacement` of the
///     `IfcGrid` that owns the location's axes, since the axis curves are
///     given in that grid's object coordinate system.
/// See [`GridPlacementLayout`] for the per-schema attribute positions.
pub(super) fn local_frame(
    placement: &DecodedEntity,
    ctx: &GridCtx,
    decoder: &mut EntityDecoder,
) -> PlacementResult<Matrix4<f64>> {
    let location = ctx.location.as_ref()
        .ok_or_else(|| missing(decoder, placement.id, "PlacementLocation"))?;
    try_resolve_grid_intersection(placement, location, &ctx.layout, decoder)
}

/// Decode `IfcGridPlacement.PlacementLocation` (an
/// `IfcVirtualGridIntersection`) into a grid-local transform: locate the
/// grid-axis intersection point and orient it by the optional
/// `PlacementRefDirection`. Malformed structure or parallel axes refuse the
/// placement; only a missing or readable-degenerate direction stays axis-aligned.
fn try_resolve_grid_intersection(
    placement: &DecodedEntity,
    location: &DecodedEntity,
    layout: &GridPlacementLayout,
    decoder: &mut EntityDecoder,
) -> PlacementResult<Matrix4<f64>> {
    let p = grid_intersection_point(location, decoder)?
        .ok_or_else(|| missing(decoder, placement.id, "a resolvable grid intersection"))?;

    // Orientation from PlacementRefDirection:
    //   • IfcDirection              → its XY is local +X directly.
    //   • IfcVirtualGridIntersection → local +X points from this location
    //                                  to that second intersection.
    //   • null / readable zero       → axis-aligned (inherit grid orientation).
    let mut m = match grid_ref_direction_vector(placement, layout.ref_direction, &p, decoder)? {
        Some(x_dir) => orient_x_in_plane(x_dir),
        None => Matrix4::identity(),
    };
    m[(0, 3)] = p.x;
    m[(1, 3)] = p.y;
    m[(2, 3)] = p.z; // grid axes are planar (z = 0); elevation via offset
    Ok(m)
}

/// Resolve an `IfcVirtualGridIntersection` to a grid-local point: intersect
/// its two `IfcGridAxis` curves in the grid plane, shift by the optional
/// per-axis lateral `OffsetDistances`, and lift by the optional elevation
/// (third offset → z). `None` when the axes are missing or parallel.
fn grid_intersection_point(
    intersection: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> PlacementResult<Option<Point3<f64>>> {
    // IntersectingAxes (attr 0) — a set of exactly two IfcGridAxis.
    let Some(axes_attr) = intersection.attr(slot::IfcVirtualGridIntersection::INTERSECTING_AXES) else {
        return Ok(None);
    };
    let axes = decoder.resolve_ref_list(axes_attr)?;
    if axes.len() != 2 || axes.iter().any(|axis| axis.ifc_type != IfcType::IfcGridAxis) {
        return Ok(None);
    }
    let Some((a0, a_dir)) = grid_axis_line(&axes[0], decoder)? else { return Ok(None) };
    let Some((b0, b_dir)) = grid_axis_line(&axes[1], decoder)? else { return Ok(None) };

    // OffsetDistances (attr 1, optional) — [from axis 1, from axis 2,
    // elevation]. The first two are perpendicular distances from each
    // axis (the point lies on a line parallel to the axis at that
    // distance); the third is a vertical offset.
    let Some([off_u, off_v, off_z]) = grid_offsets(intersection) else { return Ok(None) };

    // Shift each axis line parallel to itself toward its left normal by the
    // corresponding offset, then intersect the offset lines.
    let n_a = left_normal(a_dir);
    let n_b = left_normal(b_dir);
    let pa = Point2::new(a0.x + n_a.x * off_u, a0.y + n_a.y * off_u);
    let pb = Point2::new(b0.x + n_b.x * off_v, b0.y + n_b.y * off_v);
    Ok(line_intersection_2d(pa, a_dir, pb, b_dir).map(|p| Point3::new(p.x, p.y, off_z)))
}

/// Existing zero defaults apply only to missing offsets, never unreadable ones.
fn grid_offsets(intersection: &DecodedEntity) -> Option<[f64; 3]> {
    let offsets = match intersection.attr(slot::IfcVirtualGridIntersection::OFFSET_DISTANCES) {
        None | Some(AttributeValue::Null | AttributeValue::Derived) => return Some([0.0; 3]),
        Some(AttributeValue::List(items)) if (2..=3).contains(&items.len()) => items,
        Some(_) => return None,
    };
    let values = [
        offsets.first()?.as_float()?,
        offsets.get(1)?.as_float()?,
        offsets.get(2).map(|v| v.as_float()).unwrap_or(Some(0.0))?,
    ];
    values.iter().all(|v| v.is_finite()).then_some(values)
}

/// Read an `IfcGridAxis` into a point-and-direction line in the grid
/// plane: resolve its `AxisCurve` (attr 1) to points and take the first
/// and last as the line's endpoints. Grid axes are straight in practice;
/// a multi-segment curve degrades to its chord. `None` when the curve
/// can't be sampled to ≥ 2 distinct points.
fn grid_axis_line(
    axis: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> PlacementResult<Option<(Point2<f64>, Vector2<f64>)>> {
    let Some(curve) = decoder.resolve_optional(axis, slot::IfcGridAxis::AXIS_CURVE.index())? else {
        return Ok(None);
    };
    let processor = ProfileProcessor::new(IfcSchema::new());
    let Some(pts) = sampled(processor.get_curve_points(&curve, decoder, TessellationQuality::Medium))? else {
        return Ok(None);
    };
    if pts.len() < 2 {
        return Ok(None);
    }
    let start = &pts[0];
    let end = &pts[pts.len() - 1];
    let dir = Vector2::new(end.x - start.x, end.y - start.y);
    if dir.norm() < 1e-9 {
        return Ok(None);
    }
    Ok(Some((Point2::new(start.x, start.y), dir)))
}

/// Resolve the optional `PlacementRefDirection` into a 2D local +X
/// direction in the grid plane, covering both members of
/// `IfcGridPlacementDirectionSelect` (and IFC2X3's intersection-only type):
///   • `IfcDirection`              → its XY components.
///   • `IfcVirtualGridIntersection` → the vector from `origin` (the
///     placement location) to that second intersection point.
/// Missing and readable-degenerate directions keep the inherited orientation;
/// present unreadable directions refuse instead of fabricating identity (#7877).
fn grid_ref_direction_vector(
    placement: &DecodedEntity,
    direction_slot: Option<usize>,
    origin: &Point3<f64>,
    decoder: &mut EntityDecoder,
) -> PlacementResult<Option<Vector2<f64>>> {
    let Some(direction_slot) = direction_slot else { return Ok(None) };
    let Some(entity) = decoder.resolve_optional(placement, direction_slot)? else { return Ok(None) };
    let x = match entity.ifc_type {
        IfcType::IfcDirection => {
            let d = decoder.direction3(entity.id)?;
            Vector2::new(d[0], d[1])
        }
        IfcType::IfcVirtualGridIntersection => {
            let q = grid_intersection_point(&entity, decoder)?
                .ok_or_else(|| missing(decoder, entity.id, "a resolvable grid intersection"))?;
            Vector2::new(q.x - origin.x, q.y - origin.y)
        }
        _ => return Err(unsupported(decoder, entity.id, entity.ifc_type)),
    };
    if !(x.x.is_finite() && x.y.is_finite()) {
        return Err(missing(decoder, entity.id, "a finite PlacementRefDirection"));
    }
    let norm = x.norm();
    if norm.is_infinite() {
        // Finite direction ratios can overflow the squared norm. Rescale only
        // this case, preserving ordinary frames while making normalization safe.
        return Ok(Some(x / x.x.abs().max(x.y.abs())));
    }
    Ok((norm >= 1e-9).then_some(x))
}

/// Build a rotation matrix whose local +X follows the given in-plane
/// direction and +Z is world up (+Y = Z × X). Translation is left at the
/// origin for the caller to fill in. The input must be non-degenerate
/// (callers guarantee a non-zero vector).
fn orient_x_in_plane(x_dir: Vector2<f64>) -> Matrix4<f64> {
    let z = Vector3::new(0.0, 0.0, 1.0);
    let x = Vector3::new(x_dir.x, x_dir.y, 0.0).normalize();
    let y = z.cross(&x).normalize();
    let mut m = Matrix4::<f64>::identity();
    m.fixed_view_mut::<3, 1>(0, 0).copy_from(&x);
    m.fixed_view_mut::<3, 1>(0, 1).copy_from(&y);
    m.fixed_view_mut::<3, 1>(0, 2).copy_from(&z);
    m
}

/// Left-hand (+90°) unit normal of a 2D direction, or zero when the input is
/// degenerate. Used to shift a grid axis parallel to itself by an offset.
fn left_normal(dir: Vector2<f64>) -> Vector2<f64> {
    let n = Vector2::new(-dir.y, dir.x);
    let len = n.norm();
    if len < 1e-9 {
        Vector2::new(0.0, 0.0)
    } else {
        n / len
    }
}

/// Intersect two lines given as point + direction in 2D. Returns `None` when
/// the directions are parallel (no unique intersection).
fn line_intersection_2d(
    p1: Point2<f64>,
    d1: Vector2<f64>,
    p2: Point2<f64>,
    d2: Vector2<f64>,
) -> Option<Point2<f64>> {
    crate::math::geom2d::line_intersection_dir([p1.x, p1.y], [d1.x, d1.y], [p2.x, p2.y], [d2.x, d2.y])
        .map(|p| Point2::new(p[0], p[1]))
}

