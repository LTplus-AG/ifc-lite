// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::outline::{fillet_outline, push_arc, rounded_rectangle_outline};
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

        let half_overall_width = bottom_width.max(top_width) * 0.5;
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
        let _ = half_overall_width; // (kept for future fillet/slope work)
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

    /// Process L-shape profile (angle)
    /// IfcLShapeProfileDef: ProfileType, ProfileName, Position, Depth, Width, Thickness, ...
    pub(super) fn process_l_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        // IfcLShapeProfileDef: Depth(3), Width(4), Thickness(5), FilletRadius(6),
        // EdgeRadius(7), LegSlope(8). Built corner-at-origin (heel at (0,0),
        // horizontal leg along +X, vertical leg along +Y); `center_on_bbox`
        // re-centres it. LegSlope (tapered legs) is rare and not modelled.
        let depth = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("L-Shape missing Depth".to_string()))?;
        let width = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("L-Shape missing Width".to_string()))?;
        let t = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("L-Shape missing Thickness".to_string()))?;

        // FilletRadius rounds the inner re-entrant corner (concave, adds
        // material); EdgeRadius rounds the two leg toes (convex, removes the
        // sharp tips). Both optional; clamp so the arcs stay inside the legs.
        let rf = profile
            .get_float(6)
            .unwrap_or(0.0)
            .clamp(0.0, (width - t).min(depth - t).max(0.0));
        let re = profile.get_float(7).unwrap_or(0.0).clamp(0.0, t * 0.999);
        // Root-fillet segments per corner: 6 at Medium+, coarser below.
        let seg = self.quality().profile_arc_segments(6, 2);
        let half_pi = std::f64::consts::FRAC_PI_2;
        let pi = std::f64::consts::PI;

        // Counter-clockwise from the heel.
        let mut p: Vec<Point2<f64>> = Vec::new();
        p.push(Point2::new(0.0, 0.0)); // heel (outer corner) — sharp
        p.push(Point2::new(width, 0.0)); // horizontal leg outer end — sharp
        // horizontal leg toe (width, t): convex EdgeRadius
        if re > 1.0e-9 {
            push_arc(&mut p, width - re, t - re, re, 0.0, half_pi, seg);
        } else {
            p.push(Point2::new(width, t));
        }
        // inner re-entrant corner (t, t): concave FilletRadius
        if rf > 1.0e-9 {
            push_arc(&mut p, t + rf, t + rf, rf, 1.5 * pi, pi, seg);
        } else {
            p.push(Point2::new(t, t));
        }
        // vertical leg toe (t, depth): convex EdgeRadius
        if re > 1.0e-9 {
            push_arc(&mut p, t - re, depth - re, re, 0.0, half_pi, seg);
        } else {
            p.push(Point2::new(t, depth));
        }
        p.push(Point2::new(0.0, depth)); // vertical leg outer end — sharp

        Ok(Profile2D::new(p))
    }

    /// Process U-shape profile (channel)
    /// IfcUShapeProfileDef: ProfileType, ProfileName, Position, Depth, FlangeWidth, WebThickness, FlangeThickness, ...
    pub(super) fn process_u_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let depth = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("U-Shape missing Depth".to_string()))?;
        let flange_width = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("U-Shape missing FlangeWidth".to_string()))?;
        let web_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("U-Shape missing WebThickness".to_string()))?;
        let flange_thickness = profile
            .get_float(6)
            .ok_or_else(|| Error::geometry("U-Shape missing FlangeThickness".to_string()))?;

        // FilletRadius (attr 7) rounds the two inner web↔flange junctions
        // (concave); EdgeRadius (attr 8) rounds the two flange toes (convex).
        // FlangeSlope (9) not modelled.
        let half_depth = depth / 2.0;
        let ft = flange_thickness;
        let rf = profile
            .get_float(7)
            .unwrap_or(0.0)
            .clamp(0.0, (flange_width - web_thickness).min(half_depth - ft).max(0.0));
        let re = profile.get_float(8).unwrap_or(0.0).clamp(0.0, ft * 0.999);

        // Sharp outline (counter-clockwise). 2,5 = flange toes; 3,4 = junctions.
        let sharp = [
            Point2::new(0.0, -half_depth),               // 0 back-bottom outer
            Point2::new(flange_width, -half_depth),       // 1 bottom toe outer
            Point2::new(flange_width, -half_depth + ft),  // 2 bottom toe inner (edge)
            Point2::new(web_thickness, -half_depth + ft), // 3 bottom junction (fillet)
            Point2::new(web_thickness, half_depth - ft),  // 4 top junction (fillet)
            Point2::new(flange_width, half_depth - ft),   // 5 top toe inner (edge)
            Point2::new(flange_width, half_depth),        // 6 top toe outer
            Point2::new(0.0, half_depth),                 // 7 back-top outer
        ];
        // Root-fillet segments per corner: 6 at Medium+, coarser below.
        let seg = self.quality().profile_arc_segments(6, 2);
        let radii = [(2, re), (3, rf), (4, rf), (5, re)];
        Ok(Profile2D::new(fillet_outline(&sharp, &radii, seg)))
    }

    /// Process T-shape profile
    /// IfcTShapeProfileDef: ProfileType, ProfileName, Position, Depth, FlangeWidth, WebThickness, FlangeThickness, ...
    pub(super) fn process_t_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let depth = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("T-Shape missing Depth".to_string()))?;
        let flange_width = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("T-Shape missing FlangeWidth".to_string()))?;
        let web_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("T-Shape missing WebThickness".to_string()))?;
        let flange_thickness = profile
            .get_float(6)
            .ok_or_else(|| Error::geometry("T-Shape missing FlangeThickness".to_string()))?;

        // FilletRadius (attr 7) rounds the two web↔flange junctions (concave);
        // FlangeEdgeRadius (8) rounds the flange toes; WebEdgeRadius (9) rounds
        // the web's free end. Flange/Web slopes (10/11) not modelled.
        let half_flange = flange_width / 2.0;
        let half_web = web_thickness / 2.0;
        let ft = flange_thickness;
        let ftf = depth - ft; // flange inner face Y
        let rf = profile
            .get_float(7)
            .unwrap_or(0.0)
            .clamp(0.0, (half_flange - half_web).min(ftf).max(0.0));
        let r_fl = profile.get_float(8).unwrap_or(0.0).clamp(0.0, ft * 0.999);
        let r_web = profile.get_float(9).unwrap_or(0.0).clamp(0.0, half_web * 0.999);

        // Sharp outline (counter-clockwise). 1,6 = junctions; 2,5 = flange toes;
        // 0,7 = web free-end corners.
        let sharp = [
            Point2::new(-half_web, 0.0),       // 0 web bottom-left (web edge)
            Point2::new(-half_web, ftf),       // 1 left junction (fillet)
            Point2::new(-half_flange, ftf),    // 2 flange left toe inner (flange edge)
            Point2::new(-half_flange, depth),  // 3 flange left toe top
            Point2::new(half_flange, depth),   // 4 flange right toe top
            Point2::new(half_flange, ftf),     // 5 flange right toe inner (flange edge)
            Point2::new(half_web, ftf),        // 6 right junction (fillet)
            Point2::new(half_web, 0.0),        // 7 web bottom-right (web edge)
        ];
        // Root-fillet segments per corner: 6 at Medium+, coarser below.
        let seg = self.quality().profile_arc_segments(6, 2);
        let radii = [
            (0, r_web),
            (1, rf),
            (2, r_fl),
            (5, r_fl),
            (6, rf),
            (7, r_web),
        ];
        Ok(Profile2D::new(fillet_outline(&sharp, &radii, seg)))
    }

    /// Process C-shape profile (channel with lips)
    /// IfcCShapeProfileDef: ProfileType, ProfileName, Position, Depth, Width, WallThickness, Girth, ...
    pub(super) fn process_c_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        // IfcCShapeProfileDef: Depth(3), Width(4), WallThickness(5), Girth(6),
        // InternalFilletRadius(7). A lipped channel symmetric about its X-axis:
        // a web on the left, top/bottom flanges spanning the full Width, and
        // return lips of length Girth at the flange tips.
        let depth = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("C-Shape missing Depth".to_string()))?;
        let width = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("C-Shape missing Width".to_string()))?;
        let wall_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("C-Shape missing WallThickness".to_string()))?;
        let girth = profile.get_float(6).unwrap_or(wall_thickness * 2.0); // Lip length

        let half_depth = depth / 2.0;
        let t = wall_thickness;

        // Counter-clockwise outline. Previously this used `girth` as the X
        // extent and dropped `width` entirely, so the channel came out only
        // ~girth wide (a few × the thickness) instead of its full Width. The
        // flanges now span [0, Width]; the lips turn inward by Girth at x=Width.
        let points = vec![
            Point2::new(0.0, -half_depth),                  // bottom-left outer
            Point2::new(width, -half_depth),                // bottom-right outer
            Point2::new(width, -half_depth + girth),        // bottom lip tip
            Point2::new(width - t, -half_depth + girth),    // bottom lip inner
            Point2::new(width - t, -half_depth + t),        // bottom flange inner
            Point2::new(t, -half_depth + t),                // web inner bottom
            Point2::new(t, half_depth - t),                 // web inner top
            Point2::new(width - t, half_depth - t),         // top flange inner
            Point2::new(width - t, half_depth - girth),     // top lip inner
            Point2::new(width, half_depth - girth),         // top lip tip
            Point2::new(width, half_depth),                 // top-right outer
            Point2::new(0.0, half_depth),                   // top-left outer
        ];

        Ok(Profile2D::new(points))
    }

    /// Process Z-shape profile
    /// IfcZShapeProfileDef: ProfileType, ProfileName, Position, Depth, FlangeWidth, WebThickness, FlangeThickness, ...
    pub(super) fn process_z_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let depth = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("Z-Shape missing Depth".to_string()))?;
        let flange_width = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("Z-Shape missing FlangeWidth".to_string()))?;
        let web_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("Z-Shape missing WebThickness".to_string()))?;
        let flange_thickness = profile
            .get_float(6)
            .ok_or_else(|| Error::geometry("Z-Shape missing FlangeThickness".to_string()))?;

        let half_depth = depth / 2.0;
        let half_web = web_thickness / 2.0;

        // Z-shape profile (counter-clockwise)
        let points = vec![
            Point2::new(-half_web, -half_depth),
            Point2::new(-half_web - flange_width, -half_depth),
            Point2::new(-half_web - flange_width, -half_depth + flange_thickness),
            Point2::new(-half_web, -half_depth + flange_thickness),
            Point2::new(-half_web, half_depth - flange_thickness),
            Point2::new(half_web, half_depth - flange_thickness),
            Point2::new(half_web, half_depth),
            Point2::new(half_web + flange_width, half_depth),
            Point2::new(half_web + flange_width, half_depth - flange_thickness),
            Point2::new(half_web, half_depth - flange_thickness),
            Point2::new(half_web, -half_depth + flange_thickness),
            Point2::new(-half_web, -half_depth + flange_thickness),
        ];

        Ok(Profile2D::new(points))
    }
}
