// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcGridPlacement resolution (#883): locate the grid-axis intersection and orient it.

use super::super::GeometryRouter;
use crate::profiles::ProfileProcessor;
use crate::{Point2, Point3, Result, TessellationQuality, Vector2, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

impl GeometryRouter {
    /// Resolve `IfcGridPlacement` into a 4×4 transform by locating the
    /// referenced grid-axis intersection. Never panics; degrades to the
    /// parent transform (or identity) when the intersection can't be read.
    ///
    /// Attribute layout (IFC4x3 — `PlacementRelTo` is inherited from the
    /// `IfcObjectPlacement` supertype, hence index 0):
    ///   0 PlacementRelTo        (IfcObjectPlacement, optional) — the grid's
    ///                           own placement; composes like IfcLocalPlacement.
    ///   1 PlacementLocation     (IfcVirtualGridIntersection) — the axis pair
    ///                           and offsets the product sits on.
    ///   2 PlacementRefDirection (IfcGridPlacementDirectionSelect, optional) —
    ///                           an IfcDirection sets local +X; the
    ///                           IfcVirtualGridIntersection variant is not yet
    ///                           handled (falls back to the grid orientation).
    pub(super) fn resolve_grid_placement_with_depth(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: usize,
    ) -> Result<Matrix4<f64>> {
        // PlacementRelTo (attr 0) composes the same way IfcLocalPlacement does
        // — it carries the grid's own world position/orientation.
        let parent_transform = match placement.get(0) {
            Some(attr) if !attr.is_null() => match decoder.resolve_ref(attr)? {
                Some(parent) => {
                    self.get_placement_transform_with_depth(&parent, decoder, depth + 1)?
                }
                None => Matrix4::identity(),
            },
            _ => Matrix4::identity(),
        };

        // PlacementLocation (attr 1) → grid-local transform at the intersection.
        let local = self
            .try_resolve_grid_intersection(placement, decoder)
            .unwrap_or_else(Matrix4::identity);

        Ok(parent_transform * local)
    }

    /// Decode `IfcGridPlacement.PlacementLocation` (an
    /// `IfcVirtualGridIntersection`) into a grid-local transform: locate the
    /// grid-axis intersection point and orient it by the optional
    /// `PlacementRefDirection`. Returns `None` (→ caller keeps the grid's own
    /// transform) when the structure is malformed or the axes are parallel.
    fn try_resolve_grid_intersection(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Matrix4<f64>> {
        // PlacementLocation (attr 1) → the grid intersection the product sits on.
        let loc_attr = placement.get(1)?;
        if loc_attr.is_null() {
            return None;
        }
        let location = decoder.resolve_ref(loc_attr).ok().flatten()?;
        if location.ifc_type != IfcType::IfcVirtualGridIntersection {
            return None;
        }
        let p = self.grid_intersection_point(&location, decoder)?;

        // Orientation from PlacementRefDirection (attr 2) — full
        // IfcGridPlacementDirectionSelect coverage:
        //   • IfcDirection              → its XY is local +X directly.
        //   • IfcVirtualGridIntersection → local +X points from this location
        //                                  to that second intersection.
        //   • null / unresolved         → axis-aligned (inherit grid orientation).
        let mut m = match self.grid_ref_direction_vector(placement, &p, decoder) {
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
        let off_u = offsets.and_then(|o| o.first()).and_then(|v| v.as_float()).unwrap_or(0.0);
        let off_v = offsets.and_then(|o| o.get(1)).and_then(|v| v.as_float()).unwrap_or(0.0);
        let off_z = offsets.and_then(|o| o.get(2)).and_then(|v| v.as_float()).unwrap_or(0.0);

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

    /// Resolve the optional `PlacementRefDirection` (attr 2) into a 2D local
    /// +X direction in the grid plane, covering both members of
    /// `IfcGridPlacementDirectionSelect`:
    ///   • `IfcDirection`              → its XY components.
    ///   • `IfcVirtualGridIntersection` → the vector from `origin` (the
    ///     placement location) to that second intersection point.
    /// `None` for a null, missing, unresolved, or degenerate (zero-length)
    /// ref direction, so the caller stays axis-aligned.
    fn grid_ref_direction_vector(
        &self,
        placement: &DecodedEntity,
        origin: &Point3<f64>,
        decoder: &mut EntityDecoder,
    ) -> Option<Vector2<f64>> {
        let dir_attr = placement.get(2)?;
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
mod grid_placement_tests {
    use super::*;
    use ifc_lite_core::build_entity_index;

    // Grid axes: P = horizontal line y=0, Q = vertical line x=0 (intersect at
    // origin). S = horizontal line y=5. Two ref-direction flavours plus an
    // offset case exercise the full IfcGridPlacementDirectionSelect coverage.
    const CONTENT: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.));
#2=IFCCARTESIANPOINT((10.,0.));
#3=IFCPOLYLINE((#1,#2));
#4=IFCGRIDAXIS('P',#3,.T.);
#5=IFCCARTESIANPOINT((0.,10.));
#6=IFCPOLYLINE((#1,#5));
#7=IFCGRIDAXIS('Q',#6,.T.);
#8=IFCVIRTUALGRIDINTERSECTION((#4,#7),(0.,0.,0.));
#9=IFCCARTESIANPOINT((0.,5.));
#10=IFCCARTESIANPOINT((10.,5.));
#11=IFCPOLYLINE((#9,#10));
#12=IFCGRIDAXIS('S',#11,.T.);
#13=IFCVIRTUALGRIDINTERSECTION((#7,#12),(0.,0.,0.));
#20=IFCGRIDPLACEMENT($,#8,#13);
#21=IFCDIRECTION((0.,1.,0.));
#22=IFCGRIDPLACEMENT($,#8,#21);
#23=IFCGRIDPLACEMENT($,#8,$);
#30=IFCVIRTUALGRIDINTERSECTION((#4,#7),(2.,3.,4.));
#31=IFCGRIDPLACEMENT($,#30,$);
#40=IFCDIRECTION((0.,0.,1.));
#41=IFCDIRECTION((1.,0.,0.));
#42=IFCCARTESIANPOINT((100.,200.,300.));
#43=IFCAXIS2PLACEMENT3D(#42,#40,#41);
#44=IFCLOCALPLACEMENT($,#43);
#45=IFCGRIDPLACEMENT(#44,#8,$);
ENDSEC;
END-ISO-10303-21;
"#;

    fn transform_of(id: u32) -> Matrix4<f64> {
        let content = CONTENT.to_string();
        let ei = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, ei);
        let router = GeometryRouter::new();
        let placement = decoder
            .decode_by_id(id)
            .unwrap_or_else(|e| panic!("decode #{id}: {e:?}"));
        router
            .get_placement_transform(&placement, &mut decoder)
            .unwrap_or_else(|e| panic!("transform #{id}: {e:?}"))
    }

    fn x_axis(m: &Matrix4<f64>) -> Vector3<f64> {
        Vector3::new(m[(0, 0)], m[(1, 0)], m[(2, 0)])
    }
    fn origin(m: &Matrix4<f64>) -> Point3<f64> {
        Point3::new(m[(0, 3)], m[(1, 3)], m[(2, 3)])
    }

    #[test]
    fn ref_direction_as_ifc_direction_sets_local_x() {
        let m = transform_of(22);
        assert!((x_axis(&m) - Vector3::new(0.0, 1.0, 0.0)).norm() < 1e-9);
        assert!((origin(&m) - Point3::new(0.0, 0.0, 0.0)).norm() < 1e-9);
    }

    #[test]
    fn ref_direction_as_virtual_intersection_points_x_toward_it() {
        // Location is (0,0); ref intersection #13 is (0,5) → +X must be +Y.
        let m = transform_of(20);
        assert!((x_axis(&m) - Vector3::new(0.0, 1.0, 0.0)).norm() < 1e-9);
        assert!((origin(&m) - Point3::new(0.0, 0.0, 0.0)).norm() < 1e-9);
    }

    #[test]
    fn null_ref_direction_stays_axis_aligned() {
        let m = transform_of(23);
        assert!((x_axis(&m) - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-9);
        assert!((origin(&m) - Point3::new(0.0, 0.0, 0.0)).norm() < 1e-9);
    }

    #[test]
    fn offset_distances_shift_the_intersection() {
        // off_u=2 (perp to P → +Y), off_v=3 (perp to Q → -X), elevation=4.
        let m = transform_of(31);
        assert!((origin(&m) - Point3::new(-3.0, 2.0, 4.0)).norm() < 1e-9, "origin={:?}", origin(&m));
    }

    #[test]
    fn placement_rel_to_composes_with_the_grid_placement() {
        // PlacementRelTo #44 sits at (100,200,300); the intersection is local
        // (0,0). The composed transform must land at the grid's world offset —
        // this is the parent ∘ local path that positions a real grid relative
        // to its storey/site (and the reporter's grid at (-17000,16000,0)).
        let m = transform_of(45);
        assert!(
            (origin(&m) - Point3::new(100.0, 200.0, 300.0)).norm() < 1e-9,
            "origin={:?}",
            origin(&m)
        );
        assert!((x_axis(&m) - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-9);
    }
}
