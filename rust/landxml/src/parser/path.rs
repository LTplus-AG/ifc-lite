/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;

impl Parser<'_> {
    pub(super) fn source_data_point_dimension(&self) -> Option<u8> {
        if self.frames.iter().any(|frame| !frame.target) {
            return None;
        }
        let path: Vec<&str> = self
            .frames
            .iter()
            .map(|frame| frame.local.as_str())
            .collect();
        match path.as_slice() {
            ["LandXML", "Surfaces", "Surface", "SourceData", "DataPoints", "PntList3D"] => Some(3),
            ["LandXML", "Surfaces", "Surface", "SourceData", "DataPoints", "PntList2D"] => Some(2),
            _ => None,
        }
    }
    pub(super) fn path_with(&self, local: &str) -> String {
        self.frames
            .iter()
            .map(|frame| frame.local.as_str())
            .chain(std::iter::once(local))
            .collect::<Vec<_>>()
            .join("/")
    }

    /// Path of a just-opened coordinate-list capture.  The opening frame is
    /// already present, so appending `local` would duplicate its leaf. Keep a
    /// sibling ordinal on every non-root segment so repeated authored parent
    /// containers cannot collide with one another.
    pub(super) fn capture_path(&self) -> String {
        self.frames
            .iter()
            .enumerate()
            .map(|(index, frame)| {
                if index == 0 {
                    frame.local.clone()
                } else {
                    format!("{}[{}]", frame.local, frame.sibling_ordinal)
                }
            })
            .collect::<Vec<_>>()
            .join("/")
    }

    pub(super) fn overlay_category(&self) -> Option<PolylineCategory> {
        if self.frames.iter().any(|frame| !frame.target) {
            return None;
        }
        let path: Vec<&str> = self
            .frames
            .iter()
            .map(|frame| frame.local.as_str())
            .collect();
        match path.as_slice() {
            ["LandXML", "Surfaces", "Surface", "Definition", "Boundaries", "Boundary", "PntList3D" | "PntList2D"]
            | ["LandXML", "Surfaces", "Surface", "SourceData", "Boundaries", "Boundary", "PntList3D" | "PntList2D"] => {
                Some(PolylineCategory::Boundary)
            }
            ["LandXML", "Surfaces", "Surface", "Definition", "Breaklines", "Breakline", "PntList3D" | "PntList2D"]
            | ["LandXML", "Surfaces", "Surface", "SourceData", "Breaklines", "Breakline", "PntList3D" | "PntList2D"] => {
                Some(PolylineCategory::Breakline)
            }
            ["LandXML", "Surfaces", "Surface", "Definition", "Contours", "Contour", "PntList3D" | "PntList2D"]
            | ["LandXML", "Surfaces", "Surface", "SourceData", "Contours", "Contour", "PntList3D" | "PntList2D"] => {
                Some(PolylineCategory::Contour)
            }
            _ => None,
        }
    }
}
