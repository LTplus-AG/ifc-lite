// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::outline::{fillet_outline, rounded_rectangle_outline};
use super::ProfileProcessor;
use crate::profile::Profile2D;
use crate::{Error, Point2, Result};
use ifc_lite_core::DecodedEntity;
use std::f64::consts::PI;

impl ProfileProcessor {
    /// Process rectangle profile
    /// IfcRectangleProfileDef: ProfileType, ProfileName, Position, XDim, YDim
    #[inline]
    pub(super) fn process_rectangle(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        // Get dimensions (attributes 3 and 4)
        let x_dim = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("Rectangle missing XDim".to_string()))?;
        let y_dim = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("Rectangle missing YDim".to_string()))?;

        // Create rectangle centered at origin
        let half_x = x_dim / 2.0;
        let half_y = y_dim / 2.0;

        let points = vec![
            Point2::new(-half_x, -half_y),
            Point2::new(half_x, -half_y),
            Point2::new(half_x, half_y),
            Point2::new(-half_x, half_y),
        ];

        Ok(Profile2D::new(points))
    }

    /// Process rounded rectangle profile.
    ///
    /// IfcRoundedRectangleProfileDef: ProfileType, ProfileName, Position,
    /// XDim, YDim, RoundingRadius. Inherits from IfcRectangleProfileDef.
    /// Centered at origin; corners are arcs of `radius`, clamped to
    /// `min(XDim, YDim) / 2`. Eight segments per quadrant keeps the
    /// triangulated cap cheap while still reading as round.
    pub(super) fn process_rounded_rectangle(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let x_dim = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("RoundedRectangle missing XDim".to_string()))?;
        let y_dim = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("RoundedRectangle missing YDim".to_string()))?;
        let radius = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("RoundedRectangle missing RoundingRadius".to_string()))?;

        let half_x = x_dim / 2.0;
        let half_y = y_dim / 2.0;
        let r = radius.max(0.0).min(half_x).min(half_y);
        if r < 1.0e-9 {
            return self.process_rectangle(profile);
        }

        // Reuse the shared rounded-rectangle builder (6 segments/corner at
        // Medium+, coarser below). It also dedupes seam vertices in the
        // degenerate "rounding radius == half-dim" case where the rounded
        // rectangle collapses to a circle and adjacent corner arcs share their
        // tangent point — the inline loop here used to emit duplicate points.
        Ok(Profile2D::new(rounded_rectangle_outline(
            half_x,
            half_y,
            r,
            /*ccw=*/ true,
            self.quality(),
        )))
    }

    /// Process circle profile
    /// IfcCircleProfileDef: ProfileType, ProfileName, Position, Radius
    #[inline]
    pub(super) fn process_circle(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        // Get radius (attribute 3)
        let radius = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("Circle missing Radius".to_string()))?;

        // 36 segments at Medium for a smooth appearance; scaled by quality.
        let segments = self.quality().circle_profile_segments(36);
        let mut points = Vec::with_capacity(segments);

        for i in 0..segments {
            let angle = (i as f64) * 2.0 * PI / (segments as f64);
            let x = radius * angle.cos();
            let y = radius * angle.sin();
            points.push(Point2::new(x, y));
        }

        Ok(Profile2D::new(points))
    }

    /// Process I-shape profile (simplified - basic I-beam)
    /// IfcIShapeProfileDef: ProfileType, ProfileName, Position, OverallWidth, OverallDepth, WebThickness, FlangeThickness, ...
    pub(super) fn process_i_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        // Get dimensions
        let overall_width = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("I-Shape missing OverallWidth".to_string()))?;
        let overall_depth = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("I-Shape missing OverallDepth".to_string()))?;
        let web_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("I-Shape missing WebThickness".to_string()))?;
        let flange_thickness = profile
            .get_float(6)
            .ok_or_else(|| Error::geometry("I-Shape missing FlangeThickness".to_string()))?;

        // FilletRadius (attr 7) rounds the four web↔flange junctions (concave,
        // adds the root-fillet material). FlangeEdgeRadius (8) and FlangeSlope
        // (9) are not yet modelled (rare; absent in the ara3d set).
        let fillet = profile
            .get_float(7)
            .unwrap_or(0.0)
            .clamp(0.0, ((overall_depth - 2.0 * flange_thickness) * 0.5)
                .min((overall_width - web_thickness) * 0.5)
                .max(0.0));

        let half_width = overall_width / 2.0;
        let half_depth = overall_depth / 2.0;
        let half_web = web_thickness / 2.0;
        let ftf_bot = -half_depth + flange_thickness;
        let ftf_top = half_depth - flange_thickness;

        // Sharp outline (counter-clockwise from bottom-left). Indices 3, 4, 9,
        // 10 are the web↔flange junctions that take the fillet.
        let sharp = [
            Point2::new(-half_width, -half_depth), // 0
            Point2::new(half_width, -half_depth),  // 1
            Point2::new(half_width, ftf_bot),      // 2
            Point2::new(half_web, ftf_bot),        // 3  junction
            Point2::new(half_web, ftf_top),        // 4  junction
            Point2::new(half_width, ftf_top),      // 5
            Point2::new(half_width, half_depth),   // 6
            Point2::new(-half_width, half_depth),  // 7
            Point2::new(-half_width, ftf_top),     // 8
            Point2::new(-half_web, ftf_top),       // 9  junction
            Point2::new(-half_web, ftf_bot),       // 10 junction
            Point2::new(-half_width, ftf_bot),     // 11
        ];
        // Root-fillet segments per corner: 6 at Medium+, coarser below.
        let seg = self.quality().profile_arc_segments(6, 2);
        // Indices 3, 4, 9, 10 are the four web↔flange junctions.
        let radii = [(3, fillet), (4, fillet), (9, fillet), (10, fillet)];
        Ok(Profile2D::new(fillet_outline(&sharp, &radii, seg)))
    }

    /// Process asymmetric I-shape profile.
    ///
    /// `IfcAsymmetricIShapeProfileDef` (IFC4) attributes after the three
    /// inherited `IfcParameterizedProfileDef` slots (ProfileType,
    /// ProfileName, Position):
    ///
    ///   3:  BottomFlangeWidth          (required)
    ///   4:  OverallDepth               (required)
    ///   5:  WebThickness               (required)
    ///   6:  BottomFlangeThickness      (required)
    ///   7:  BottomFlangeFilletRadius   (optional, ignored — see below)
    ///   8:  TopFlangeWidth             (required)
    ///   9:  TopFlangeThickness         (optional, falls back to BottomFlangeThickness)
    ///   10: TopFlangeFilletRadius      (optional, ignored)
    ///   11: BottomFlangeEdgeRadius     (optional, ignored)
    ///   12: BottomFlangeSlope          (optional, ignored)
    ///   13: TopFlangeEdgeRadius        (optional, ignored)
    ///   14: TopFlangeSlope             (optional, ignored)
    ///
    /// Fillet radii / edge tapers / slopes are intentionally omitted: the
    /// existing symmetric `process_i_shape` ignores them too and the bridge
    /// fixture in issue #828 doesn't need them to read correctly.
    /// `process_i_shape` ignores them too. The origin sits at the centre
    /// of the bounding rectangle (`max(top_width, bottom_width)` by
    /// `overall_depth`) — same convention as the symmetric variant, which
    /// is what Tekla, Revit, and the IfcOpenShell reference impl all emit.
    pub(super) fn process_asymmetric_i_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let bottom_width = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("AsymmetricI missing BottomFlangeWidth".to_string()))?;
        let overall_depth = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("AsymmetricI missing OverallDepth".to_string()))?;
        let web_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("AsymmetricI missing WebThickness".to_string()))?;
        let bottom_flange_thickness = profile
            .get_float(6)
            .ok_or_else(|| Error::geometry("AsymmetricI missing BottomFlangeThickness".to_string()))?;
        let top_width = profile
            .get_float(8)
            .ok_or_else(|| Error::geometry("AsymmetricI missing TopFlangeWidth".to_string()))?;
        // TopFlangeThickness is OPTIONAL in IFC4. When omitted, the IFC4
        // schema rule `IfcAsymmetricIShapeProfileDef.WR3` says the value
        // equals BottomFlangeThickness — so symmetric flange thicknesses
        // can be authored by leaving the top one $.
        let top_flange_thickness = profile.get_float(9).unwrap_or(bottom_flange_thickness);

        if overall_depth <= bottom_flange_thickness + top_flange_thickness {
            return Err(Error::geometry(format!(
                "AsymmetricI: OverallDepth {} must exceed BottomFlangeThickness + \
                 TopFlangeThickness ({} + {} = {})",
                overall_depth,
                bottom_flange_thickness,
                top_flange_thickness,
                bottom_flange_thickness + top_flange_thickness,
            )));
        }

        let half_depth = overall_depth * 0.5;
        let half_web = web_thickness * 0.5;
        let half_bottom = bottom_width * 0.5;
        let half_top = top_width * 0.5;

        // Twelve-point CCW outline starting at the bottom-flange's
        // bottom-left corner. Identical topology to `process_i_shape` but
        // with two independent flange widths. The point at `(_, -half_depth
        // + bottom_flange_thickness)` is intentionally placed at the
        // bottom-flange edge (`±half_bottom`) — *not* at the overall width
        // — so a wider bottom flange protrudes correctly.
        let points = vec![
            Point2::new(-half_bottom, -half_depth),
            Point2::new(half_bottom, -half_depth),
            Point2::new(half_bottom, -half_depth + bottom_flange_thickness),
            Point2::new(half_web, -half_depth + bottom_flange_thickness),
            Point2::new(half_web, half_depth - top_flange_thickness),
            Point2::new(half_top, half_depth - top_flange_thickness),
            Point2::new(half_top, half_depth),
            Point2::new(-half_top, half_depth),
            Point2::new(-half_top, half_depth - top_flange_thickness),
            Point2::new(-half_web, half_depth - top_flange_thickness),
            Point2::new(-half_web, -half_depth + bottom_flange_thickness),
            Point2::new(-half_bottom, -half_depth + bottom_flange_thickness),
        ];

        Ok(Profile2D::new(points))
    }

    /// Process circle hollow profile (tube/pipe)
    /// IfcCircleHollowProfileDef: ProfileType, ProfileName, Position, Radius, WallThickness
    pub(super) fn process_circle_hollow(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let radius = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("CircleHollow missing Radius".to_string()))?;
        let wall_thickness = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("CircleHollow missing WallThickness".to_string()))?;

        // Validate wall thickness (parity with RectangleHollow). A wall >= radius
        // yields a zero/negative inner radius: the inner ring collapses to the
        // centre or mirrors through the origin, leaving a self-intersecting hole.
        if wall_thickness >= radius {
            return Err(Error::geometry(format!(
                "CircleHollow WallThickness {} exceeds Radius {}",
                wall_thickness, radius
            )));
        }

        let inner_radius = radius - wall_thickness;
        let segments = self.quality().circle_profile_segments(36);

        // Outer circle
        let mut outer_points = Vec::with_capacity(segments);
        for i in 0..segments {
            let angle = (i as f64) * 2.0 * PI / (segments as f64);
            outer_points.push(Point2::new(radius * angle.cos(), radius * angle.sin()));
        }

        // Inner circle (reversed for hole)
        let mut inner_points = Vec::with_capacity(segments);
        for i in (0..segments).rev() {
            let angle = (i as f64) * 2.0 * PI / (segments as f64);
            inner_points.push(Point2::new(
                inner_radius * angle.cos(),
                inner_radius * angle.sin(),
            ));
        }

        let mut result = Profile2D::new(outer_points);
        result.add_hole(inner_points);
        Ok(result)
    }

    /// Process rectangle hollow profile (rectangular tube)
    /// IfcRectangleHollowProfileDef: ProfileType, ProfileName, Position, XDim, YDim, WallThickness, InnerFilletRadius, OuterFilletRadius
    ///
    /// Both fillet radii are optional in the schema. When set, they replace the
    /// sharp 90° corners with quarter-circle arcs:
    ///
    /// * `OuterFilletRadius = R_o` rounds each outer corner with radius R_o.
    /// * `InnerFilletRadius = R_i` rounds the corresponding inner corner. When
    ///   `R_i == min(inner_half_x, inner_half_y)` the four inner arcs meet and
    ///   the inner hole degenerates to a circle (issue #854 — RHS with a thin
    ///   wall and circular bore, common for HVAC diffusers).
    ///
    /// The standard requires `R_o >= R_i + WallThickness` for a uniform-thickness
    /// shell, but BIM authoring tools sometimes violate that; we tessellate
    /// whatever radii were authored and let the renderer show the result.
    pub(super) fn process_rectangle_hollow(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let x_dim = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("RectangleHollow missing XDim".to_string()))?;
        let y_dim = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("RectangleHollow missing YDim".to_string()))?;
        let wall_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("RectangleHollow missing WallThickness".to_string()))?;

        let half_x = x_dim / 2.0;
        let half_y = y_dim / 2.0;

        // Validate wall thickness
        if wall_thickness >= half_x || wall_thickness >= half_y {
            return Err(Error::geometry(format!(
                "RectangleHollow WallThickness {} exceeds half dimensions ({}, {})",
                wall_thickness, half_x, half_y
            )));
        }

        let inner_half_x = half_x - wall_thickness;
        let inner_half_y = half_y - wall_thickness;

        // InnerFilletRadius is attr 6, OuterFilletRadius is attr 7. Both
        // optional; `None` (or a value below 1 µm) collapses to sharp
        // corners. Clamp to the half-extent so an authored value larger
        // than the inner half-dim doesn't fold the polygon inside-out.
        let inner_fillet = profile
            .get_float(6)
            .unwrap_or(0.0)
            .max(0.0)
            .min(inner_half_x)
            .min(inner_half_y);
        let outer_fillet = profile
            .get_float(7)
            .unwrap_or(0.0)
            .max(0.0)
            .min(half_x)
            .min(half_y);

        let q = self.quality();
        let outer_points =
            rounded_rectangle_outline(half_x, half_y, outer_fillet, /*ccw=*/ true, q);
        let inner_points =
            rounded_rectangle_outline(inner_half_x, inner_half_y, inner_fillet, /*ccw=*/ false, q);

        let mut result = Profile2D::new(outer_points);
        result.add_hole(inner_points);
        Ok(result)
    }
}
