// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parametric hot-rolled steel section profiles (L / U / T / C / Z). Split out of
//! `shapes.rs` to keep both files under the module-size ratchet.

use super::outline::{fillet_outline, push_arc};
use super::ProfileProcessor;
use crate::profile::Profile2D;
use crate::{Error, Point2, Result};
use ifc_lite_core::DecodedEntity;

/// Reject a non-finite or non-positive required profile dimension
/// (`IfcPositiveLengthMeasure`). A negative value both makes a fillet-radius
/// `clamp` bound negative (panicking `f64::clamp`) and yields mirrored/garbage
/// geometry, so returning `Err` skips the one element, mirroring the existing
/// missing-attribute errors. The finite check is what rejects `NaN` (`NaN <= 0.0`
/// is `false`).
fn require_positive(value: f64, what: &str) -> Result<()> {
    if value.is_finite() && value > 0.0 {
        Ok(())
    } else {
        Err(Error::geometry(format!(
            "{what} must be a positive length, got {value}"
        )))
    }
}

impl ProfileProcessor {
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
        require_positive(depth, "L-Shape Depth")?;
        require_positive(width, "L-Shape Width")?;
        require_positive(t, "L-Shape Thickness")?;

        // FilletRadius rounds the inner re-entrant corner (concave, adds
        // material); EdgeRadius rounds the two leg toes (convex, removes the
        // sharp tips). Both optional; clamp so the arcs stay inside the legs.
        // Below Medium both collapse to 0 — sharp corners only (issue #1809).
        let q = self.quality();
        let rf = q.profile_fillet_radius(
            profile
                .get_float(6)
                .unwrap_or(0.0)
                .clamp(0.0, (width - t).min(depth - t).max(0.0)),
        );
        let re = q.profile_fillet_radius(
            profile.get_float(7).unwrap_or(0.0).clamp(0.0, (t * 0.999).max(0.0)),
        );
        // Root-fillet segments per corner: 6 at Medium+, coarser below.
        let seg = q.profile_arc_segments(6, 2);
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
        require_positive(depth, "U-Shape Depth")?;
        require_positive(flange_width, "U-Shape FlangeWidth")?;
        require_positive(web_thickness, "U-Shape WebThickness")?;
        require_positive(flange_thickness, "U-Shape FlangeThickness")?;

        // FilletRadius (attr 7) rounds the two inner web↔flange junctions
        // (concave); EdgeRadius (attr 8) rounds the two flange toes (convex).
        // FlangeSlope (9) not modelled.
        // Below Medium both collapse to 0 — sharp corners only (issue #1809).
        let half_depth = depth / 2.0;
        let ft = flange_thickness;
        let q = self.quality();
        let rf = q.profile_fillet_radius(
            profile
                .get_float(7)
                .unwrap_or(0.0)
                .clamp(0.0, (flange_width - web_thickness).min(half_depth - ft).max(0.0)),
        );
        let re = q.profile_fillet_radius(
            profile.get_float(8).unwrap_or(0.0).clamp(0.0, (ft * 0.999).max(0.0)),
        );

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
        let seg = q.profile_arc_segments(6, 2);
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
        require_positive(depth, "T-Shape Depth")?;
        require_positive(flange_width, "T-Shape FlangeWidth")?;
        require_positive(web_thickness, "T-Shape WebThickness")?;
        require_positive(flange_thickness, "T-Shape FlangeThickness")?;

        // FilletRadius (attr 7) rounds the two web↔flange junctions (concave);
        // FlangeEdgeRadius (8) rounds the flange toes; WebEdgeRadius (9) rounds
        // the web's free end. Flange/Web slopes (10/11) not modelled.
        let half_flange = flange_width / 2.0;
        let half_web = web_thickness / 2.0;
        let ft = flange_thickness;
        let ftf = depth - ft; // flange inner face Y
        // Below Medium all three collapse to 0 — sharp corners only (issue #1809).
        let q = self.quality();
        let rf = q.profile_fillet_radius(
            profile
                .get_float(7)
                .unwrap_or(0.0)
                .clamp(0.0, (half_flange - half_web).min(ftf).max(0.0)),
        );
        let r_fl = q.profile_fillet_radius(
            profile.get_float(8).unwrap_or(0.0).clamp(0.0, (ft * 0.999).max(0.0)),
        );
        let r_web = q.profile_fillet_radius(
            profile.get_float(9).unwrap_or(0.0).clamp(0.0, (half_web * 0.999).max(0.0)),
        );

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
        let seg = q.profile_arc_segments(6, 2);
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
        require_positive(depth, "C-Shape Depth")?;
        require_positive(width, "C-Shape Width")?;
        require_positive(wall_thickness, "C-Shape WallThickness")?;
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
        require_positive(depth, "Z-Shape Depth")?;
        require_positive(flange_width, "Z-Shape FlangeWidth")?;
        require_positive(web_thickness, "Z-Shape WebThickness")?;
        require_positive(flange_thickness, "Z-Shape FlangeThickness")?;

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
