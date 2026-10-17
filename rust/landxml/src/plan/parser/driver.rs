/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! The plan family as a [`FamilyHandler`]: what each element and its text mean
//! for COGO points, monuments, parcels and plan features (C9a-6).

use super::*;

impl FamilyHandler for PlanHandler {
    /// D74: markup inside a numeric capture refuses the document.
    fn check_nesting(&mut self, depth: usize) -> Result<()> {
        if self.capture.as_ref().is_some_and(|capture| capture.depth() <= depth) {
            return Err(error(
                Code::InvalidSemantic,
                "numeric LandXML capture cannot contain nested elements",
            ));
        }
        Ok(())
    }

    fn start(&mut self, cx: &Cx<'_>, element: &Element<'_>) -> Result<()> {
        let (local, attributes) = (element.local, element.attributes);
        if attr(attributes, "pntRef").is_some() {
            self.references.reserve(1)?;
        }
        if element.depth == 1 {
            self.open_root(cx)?;
        }
        if !element.target {
            return Ok(());
        }
        if matches!(local, "Metric" | "Imperial") && cx.path_is(&["LandXML", "Units", local]) {
            self.declare_units(attributes)?;
        }
        self.open_cg_points_scope(cx, local);
        if self.start_point_record(cx, local, attributes) {
            return Ok(());
        }
        if self.start_plan_record(cx, local, attributes)? {
            return Ok(());
        }
        if self.start_member(cx, local, attributes)? {
            return Ok(());
        }
        self.start_geometry_part(cx, local, attributes);
        Ok(())
    }

    fn end(&mut self, cx: &Cx<'_>) -> Result<()> {
        let depth = cx.frames().len();
        let frame = cx.frames().last().expect("an element is closing");
        if self.capture.as_ref().is_some_and(|capture| capture.depth() == depth) {
            self.finish_capture()?;
        }
        if self.geometry.as_ref().is_some_and(|geometry| geometry.depth == depth) {
            self.finish_geometry()?;
        }
        if frame.target && self.active_depths.last().is_some_and(|open| *open == depth) {
            self.finish_active()?;
        }
        if frame.target && &*frame.local == "CgPoints" {
            let closing_scope = self.scope_stack.last().map(|(_, scope)| scope.clone());
            self.scope_stack.retain(|(open, _)| *open != depth);
            self.reference_scope = self.scope_stack.last().map(|(_, scope)| scope.clone()).or(closing_scope);
        }
        Ok(())
    }

    fn text(&mut self, _cx: &Cx<'_>, text: &str) -> Result<()> {
        self.capture_text(text)
    }

    fn capture_depth(&self) -> Option<usize> {
        self.capture.as_ref().map(Capture::depth)
    }
}

impl PlanHandler {
    /// Take what the driver validated at the document element.
    fn open_root(&mut self, cx: &Cx<'_>) -> Result<()> {
        self.schema = cx.root.schema.clone();
        self.version = cx.root.version.clone();
        if let Some(diagnostic) = cx.root.diagnostic.clone() {
            self.record_capability_diagnostic(diagnostic)?;
        }
        Ok(())
    }

    /// The driver has already refused a second declaration.
    fn declare_units(&mut self, attributes: &Attributes) -> Result<()> {
        let declared_units = units(attributes)?;
        self.area_unit = attr(attributes, "areaUnit").map(str::to_owned);
        self.area_scale_to_square_meters = self
            .area_unit
            .as_deref()
            .map(area_scale)
            .transpose()?
            .or(Some(crate::semantics::square_scale(&declared_units)));
        self.units = Some(declared_units);
        Ok(())
    }

    /// `CgPoints` under the root, `Survey`, or nested in another `CgPoints`
    /// opens the scope its points belong to.
    fn open_cg_points_scope(&mut self, cx: &Cx<'_>, local: &str) {
        let frames = cx.frames();
        let legal = cx.path_is(&["LandXML", "CgPoints"])
            || cx.path_is(&["LandXML", "Survey", "CgPoints"])
            || (local == "CgPoints"
                && self.scope_stack.last().is_some_and(|(depth, _)| {
                    *depth + 1 == frames.len() && frames[*depth - 1].target && &*frames[*depth - 1].local == "CgPoints"
                }));
        if legal {
            self.scope_ordinal += 1;
            let scope = LandXmlSourceId(format!("landxml:CgPoints:{}", self.scope_ordinal));
            self.reference_scope = Some(scope.clone());
            self.scope_stack.push((frames.len(), scope));
        }
    }

    /// `CgPoint` and `Monument`: captured whole, built when they close.
    fn start_point_record(&mut self, cx: &Cx<'_>, local: &str, attributes: &Attributes) -> bool {
        let depth = cx.frames().len();
        if local == "CgPoint" && self.scope_stack.last().is_some_and(|(open, _)| *open + 1 == depth) {
            self.capture = Some(Capture::CgPoint { attributes: attributes.clone(), depth, text: String::new() });
            return true;
        }
        if cx.path_is(&["LandXML", "Monuments", "Monument"]) {
            self.capture = Some(Capture::Monument { attributes: attributes.clone(), depth, text: String::new() });
            return true;
        }
        false
    }

    /// `PlanFeature`, `Parcel`, a parcel's `CoordGeom` loop and its primitives.
    fn start_plan_record(&mut self, cx: &Cx<'_>, local: &str, attributes: &Attributes) -> Result<bool> {
        let frames = cx.frames();
        let depth = frames.len();
        if cx.path_is(&["LandXML", "PlanFeatures", "PlanFeature"]) {
            self.begin_feature(depth, attributes)?;
            return Ok(true);
        }
        let nested_parcel = local == "Parcel"
            && matches!(self.active.last(), Some(Active::Parcel(_)))
            && self.active_depths.last().is_some_and(|open| {
                depth == *open + 2 && frames[*open].target && &*frames[*open].local == "Parcels"
            });
        if cx.path_is(&["LandXML", "Parcels", "Parcel"]) || nested_parcel {
            self.begin_parcel(depth, attributes)?;
            return Ok(true);
        }
        let active_depth = self.active_depths.last().copied();
        if local == "CoordGeom" && active_depth.is_some_and(|open| depth == open + 1) {
            if let Some(Active::Parcel(parcel)) = self.active.last_mut() {
                parcel.loops.push(Vec::new());
            }
            return Ok(true);
        }
        let direct_coord_geom_child = active_depth.is_some_and(|open| {
            depth == open + 2 && cx.parent().is_some_and(|frame| frame.target && &*frame.local == "CoordGeom")
        });
        if direct_coord_geom_child && self.geometry.is_none() && matches!(local, "Line" | "Curve" | "IrregularLine") {
            self.begin_geometry(depth, local, attributes)?;
            return Ok(true);
        }
        Ok(false)
    }

    /// `Property`, `Title` and `Location` inside an open feature or parcel.
    fn start_member(&mut self, cx: &Cx<'_>, local: &str, attributes: &Attributes) -> Result<bool> {
        let frames = cx.frames();
        let depth = frames.len();
        let Some(active_depth) = self.active_depths.last().copied() else {
            return Ok(false);
        };
        let all_features = |between: &[Frame]| between.iter().all(|frame| frame.target && &*frame.local == "Feature");
        if self.geometry.is_none()
            && local == "Property"
            && all_features(&frames[active_depth..depth - 1])
            && (matches!(self.active.last(), Some(Active::Feature(_))) || depth == active_depth + 1)
        {
            self.add_property(attributes)?;
            return Ok(true);
        }
        if self.geometry.is_none()
            && local == "Title"
            && matches!(self.active.last(), Some(Active::Parcel(_)))
            && depth == active_depth + 1
        {
            if attr(attributes, "name").is_none() {
                return Err(error(Code::InvalidSemantic, "Parcel Title requires name"));
            }
            self.capture = Some(Capture::Title { attributes: attributes.clone(), depth, text: String::new() });
            return Ok(true);
        }
        if self.geometry.is_none() && local == "Location" && all_features(&frames[active_depth..depth.saturating_sub(1)]) {
            self.capture = Some(Capture::Point {
                role: "__location".to_owned(),
                depth,
                pnt_ref: attr(attributes, "pntRef").map(str::to_owned),
                text: String::new(),
            });
            return Ok(true);
        }
        Ok(false)
    }

    /// The points and coordinate lists of the primitive that is open.
    fn start_geometry_part(&mut self, cx: &Cx<'_>, local: &str, attributes: &Attributes) {
        let depth = cx.frames().len();
        let Some(geometry) = &self.geometry else { return };
        if depth != geometry.depth + 1 {
            return;
        }
        if matches!(local, "Start" | "End" | "Center" | "PI") {
            self.capture = Some(Capture::Point {
                role: local.to_owned(),
                depth,
                pnt_ref: attr(attributes, "pntRef").map(str::to_owned),
                text: String::new(),
            });
        } else if matches!(local, "PntList2D" | "PntList3D") {
            self.capture = Some(Capture::PointList {
                depth,
                dimension: if local == "PntList2D" { 2 } else { 3 },
                text: String::new(),
            });
        }
    }

    fn capture_text(&mut self, text: &str) -> Result<()> {
        if let Some(capture) = &mut self.capture {
            let target = match capture {
                Capture::CgPoint { text, .. }
                | Capture::Monument { text, .. }
                | Capture::Point { text, .. }
                | Capture::PointList { text, .. }
                | Capture::Title { text, .. } => text,
            };
            if target.len() + text.len() > self.limits.xml.max_text_bytes {
                return Err(error(Code::LimitExceeded, "captured text limit exceeded"));
            }
            target.push_str(text);
        }
        Ok(())
    }
}
