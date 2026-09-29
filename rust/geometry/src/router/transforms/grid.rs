// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcGridPlacement resolution (#883): locate the grid-axis intersection and orient it.

use super::super::GeometryRouter;
use super::mat4_to_col_array;
use super::walk::PlacementWalk;
use crate::profiles::ProfileProcessor;
use crate::{Point2, Point3, Result, TessellationQuality, Vector2, Vector3};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

/// Where `IfcGridPlacement`'s attributes sit in this source's schema.
///
/// IFC4X1 added the inherited `IfcObjectPlacement.PlacementRelTo`, so IFC4X1+
/// reads `(PlacementRelTo, PlacementLocation, PlacementRefDirection)` and
/// IFC2X3/IFC4 read `(PlacementLocation, PlacementRefDirection)`. The
/// positions come from the declared schema's generated registry
/// ([`EntityDecoder::attribute_index`]), never from a second hard-coded table.
/// `PlacementRefDirection` is an `IfcVirtualGridIntersection` on IFC2X3 and an
/// `IfcGridPlacementDirectionSelect` (IfcDirection | IfcVirtualGridIntersection)
/// from IFC4 on; [`GeometryRouter::grid_ref_direction_vector`] dispatches on
/// the referenced entity's type, so one reader covers both.
struct GridPlacementLayout {
    /// `None` on IFC2X3/IFC4: the placement is implicitly in the frame of the
    /// `IfcGrid` its axes belong to.
    rel_to: Option<usize>,
    location: Option<usize>,
    ref_direction: Option<usize>,
}

impl GridPlacementLayout {
    fn of(decoder: &mut EntityDecoder) -> Self {
        let mut index = |name| decoder.attribute_index("IfcGridPlacement", name);
        Self {
            rel_to: index("PlacementRelTo"),
            location: index("PlacementLocation"),
            ref_direction: index("PlacementRefDirection"),
        }
    }
}

impl GeometryRouter {
    /// Resolve `IfcGridPlacement` into a 4×4 transform by locating the
    /// referenced grid-axis intersection. Never panics; degrades to the
    /// parent transform (or identity) when the intersection can't be read.
    ///
    /// The result is `grid frame * intersection frame`, where the grid frame is
    ///   • IFC4X1+: `PlacementRelTo` (the grid's own placement), composed like
    ///     IfcLocalPlacement's parent;
    ///   • IFC2X3/IFC4 (no `PlacementRelTo`): the `ObjectPlacement` of the
    ///     `IfcGrid` that owns the location's axes, since the axis curves are
    ///     given in that grid's object coordinate system.
    /// See [`GridPlacementLayout`] for the per-schema attribute positions.
    pub(super) fn resolve_grid_placement_with_depth(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: usize,
    ) -> Result<PlacementWalk> {
        let layout = GridPlacementLayout::of(decoder);
        let location = layout
            .location
            .and_then(|i| placement.get(i))
            .filter(|attr| !attr.is_null())
            .and_then(|attr| decoder.resolve_ref(attr).ok().flatten())
            .filter(|loc| loc.ifc_type == IfcType::IfcVirtualGridIntersection);

        // The grid frame carries the grid's world position/orientation,
        // truncation included: a parent walk cut short by the depth guard
        // makes this result depth-dependent too, so it must not be memoised.
        // #3012
        let parent = match layout.rel_to {
            Some(i) => match placement.get(i) {
                Some(attr) if !attr.is_null() => match decoder.resolve_ref(attr)? {
                    Some(p) => self.get_placement_transform_with_depth(&p, decoder, depth + 1)?,
                    None => PlacementWalk::complete(Matrix4::identity()),
                },
                _ => PlacementWalk::complete(Matrix4::identity()),
            },
            None => match &location {
                Some(loc) => self.owning_grid_frame(loc, decoder, depth)?,
                None => PlacementWalk::complete(Matrix4::identity()),
            },
        };

        // PlacementLocation → grid-local transform at the intersection.
        let local = location
            .and_then(|loc| self.try_resolve_grid_intersection(placement, &loc, &layout, decoder))
            .unwrap_or_else(Matrix4::identity);

        Ok(PlacementWalk {
            transform: parent.transform * local,
            truncated: parent.truncated,
        })
    }

    /// World transform of the `IfcGrid` that owns `intersection`'s first axis
    /// (IFC2X3/IFC4, where `IfcGridPlacement` has no `PlacementRelTo`).
    /// Identity when no grid lists the axis or the grid has no placement.
    ///
    /// Memoised in the per-worker placement memo under the AXIS id: the grid
    /// frame is a pure function of the source and that id (entity ids are
    /// unique, so it cannot collide with a placement's own entry), and keying
    /// it there spares every later grid-placed element the owner scan
    /// ([`EntityDecoder::grid_of_axis`]) that a fresh per-element decoder would
    /// otherwise repeat. Truncated walks stay out of the memo, as everywhere.
    fn owning_grid_frame(
        &self,
        intersection: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: usize,
    ) -> Result<PlacementWalk> {
        let identity = PlacementWalk::complete(Matrix4::identity());
        let Some(axis_id) = intersection
            .get_refs(0)
            .and_then(|axes| axes.first().copied())
        else {
            return Ok(identity);
        };
        if let Some(m) = decoder.get_placement_transform_cached(axis_id) {
            return Ok(PlacementWalk::complete(Matrix4::from_column_slice(&m)));
        }
        let grid_placement = match decoder.grid_of_axis(axis_id) {
            Some(grid_id) => {
                let grid = decoder.decode_by_id(grid_id)?;
                let slot = decoder.attribute_index("IfcGrid", "ObjectPlacement");
                match slot
                    .and_then(|i| grid.get(i))
                    .filter(|attr| !attr.is_null())
                {
                    Some(attr) => decoder.resolve_ref(attr)?,
                    None => None,
                }
            }
            None => None,
        };
        let walk = match grid_placement {
            Some(p) => self.get_placement_transform_with_depth(&p, decoder, depth + 1)?,
            None => identity,
        };
        if !walk.truncated {
            decoder.cache_placement_transform(axis_id, mat4_to_col_array(&walk.transform));
        }
        Ok(walk)
    }

    /// Decode `IfcGridPlacement.PlacementLocation` (an
    /// `IfcVirtualGridIntersection`) into a grid-local transform: locate the
    /// grid-axis intersection point and orient it by the optional
    /// `PlacementRefDirection`. Returns `None` (→ caller keeps the grid's own
    /// transform) when the structure is malformed or the axes are parallel.
    fn try_resolve_grid_intersection(
        &self,
        placement: &DecodedEntity,
        location: &DecodedEntity,
        layout: &GridPlacementLayout,
        decoder: &mut EntityDecoder,
    ) -> Option<Matrix4<f64>> {
        let p = self.grid_intersection_point(location, decoder)?;

        // Orientation from PlacementRefDirection:
        //   • IfcDirection              → its XY is local +X directly.
        //   • IfcVirtualGridIntersection → local +X points from this location
        //                                  to that second intersection.
        //   • null / unresolved         → axis-aligned (inherit grid orientation).
        let ref_attr = layout.ref_direction.and_then(|i| placement.get(i));
        let mut m = match self.grid_ref_direction_vector(ref_attr, &p, decoder) {
            Some(x_dir) => orient_x_in_plane(x_dir),
            None => Matrix4::identity(),
        };
        m[(0, 3)] = p.x;
        m[(1, 3)] = p.y;
        m[(2, 3)] = p.z; // grid axes are planar (z = 0); elevation via offset
        Some(m)
    }

    /// Resolve an `IfcVirtualGridIntersection` to a grid-local point: intersect
    /// its two `IfcGridAxis` curves in the grid plane, shift by the optional
    /// per-axis lateral `OffsetDistances`, and lift by the optional elevation
    /// (third offset → z). `None` when the axes are missing or parallel.
    fn grid_intersection_point(
        &self,
        intersection: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Point3<f64>> {
        // IntersectingAxes (attr 0) — a set of exactly two IfcGridAxis.
        let axes_attr = intersection.get(0)?;
        let axes = decoder.resolve_ref_list(axes_attr).ok()?;
        if axes.len() < 2 {
            return None;
        }
        let (a0, a_dir) = self.grid_axis_line(&axes[0], decoder)?;
        let (b0, b_dir) = self.grid_axis_line(&axes[1], decoder)?;

        // OffsetDistances (attr 1, optional) — [from axis 1, from axis 2,
        // elevation]. The first two are perpendicular distances from each
        // axis (the point lies on a line parallel to the axis at that
        // distance); the third is a vertical offset.
        let offsets = intersection.get_list(1);
        let off_u = offsets
            .and_then(|o| o.first())
            .and_then(|v| v.as_float())
            .unwrap_or(0.0);
        let off_v = offsets
            .and_then(|o| o.get(1))
            .and_then(|v| v.as_float())
            .unwrap_or(0.0);
        let off_z = offsets
            .and_then(|o| o.get(2))
            .and_then(|v| v.as_float())
            .unwrap_or(0.0);

        // Shift each axis line parallel to itself toward its left normal by the
        // corresponding offset, then intersect the offset lines.
        let n_a = left_normal(a_dir);
        let n_b = left_normal(b_dir);
        let pa = Point2::new(a0.x + n_a.x * off_u, a0.y + n_a.y * off_u);
        let pb = Point2::new(b0.x + n_b.x * off_v, b0.y + n_b.y * off_v);
        let p = line_intersection_2d(pa, a_dir, pb, b_dir)?;
        Some(Point3::new(p.x, p.y, off_z))
    }

    /// Read an `IfcGridAxis` into a point-and-direction line in the grid
    /// plane: resolve its `AxisCurve` (attr 1) to points and take the first
    /// and last as the line's endpoints. Grid axes are straight in practice;
    /// a multi-segment curve degrades to its chord. `None` when the curve
    /// can't be sampled to ≥ 2 distinct points.
    fn grid_axis_line(
        &self,
        axis: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(Point2<f64>, Vector2<f64>)> {
        let curve_attr = axis.get(1)?;
        if curve_attr.is_null() {
            return None;
        }
        let curve = decoder.resolve_ref(curve_attr).ok().flatten()?;
        let processor = ProfileProcessor::new(IfcSchema::new());
        let pts = processor
            .get_curve_points(&curve, decoder, TessellationQuality::Medium)
            .ok()?;
        if pts.len() < 2 {
            return None;
        }
        let start = pts.first()?;
        let end = pts.last()?;
        let dir = Vector2::new(end.x - start.x, end.y - start.y);
        if dir.norm() < 1e-9 {
            return None;
        }
        Some((Point2::new(start.x, start.y), dir))
    }

    /// Resolve the optional `PlacementRefDirection` into a 2D local +X
    /// direction in the grid plane, covering both members of
    /// `IfcGridPlacementDirectionSelect` (and IFC2X3's intersection-only type):
    ///   • `IfcDirection`              → its XY components.
    ///   • `IfcVirtualGridIntersection` → the vector from `origin` (the
    ///     placement location) to that second intersection point.
    /// `None` for a null, missing, unresolved, or degenerate (zero-length)
    /// ref direction, so the caller stays axis-aligned.
    fn grid_ref_direction_vector(
        &self,
        dir_attr: Option<&AttributeValue>,
        origin: &Point3<f64>,
        decoder: &mut EntityDecoder,
    ) -> Option<Vector2<f64>> {
        let dir_attr = dir_attr?;
        if dir_attr.is_null() {
            return None;
        }
        let entity = decoder.resolve_ref(dir_attr).ok().flatten()?;
        let x = match entity.ifc_type {
            IfcType::IfcDirection => {
                let d = self.parse_direction(&entity).ok()?;
                Vector2::new(d.x, d.y)
            }
            IfcType::IfcVirtualGridIntersection => {
                let q = self.grid_intersection_point(&entity, decoder)?;
                Vector2::new(q.x - origin.x, q.y - origin.y)
            }
            _ => return None,
        };
        if x.norm() < 1e-9 {
            return None;
        }
        Some(x)
    }
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
    let denom = d1.x * d2.y - d1.y * d2.x;
    if denom.abs() < 1e-9 {
        return None;
    }
    let dp = p2 - p1;
    let t = (dp.x * d2.y - dp.y * d2.x) / denom;
    Some(p1 + d1 * t)
}

#[cfg(test)]
#[path = "grid_tests.rs"]
mod grid_placement_tests;
