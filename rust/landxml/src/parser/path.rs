/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;

impl Parser<'_> {
    pub(super) fn path_with(&self, local: &str) -> String {
        self.frames
            .iter()
            .map(|frame| frame.local.as_str())
            .chain(std::iter::once(local))
            .collect::<Vec<_>>()
            .join("/")
    }

    pub(super) fn overlay_category(&self) -> Option<PolylineCategory> {
        let path: Vec<&str> = self
            .frames
            .iter()
            .map(|frame| frame.local.as_str())
            .collect();
        match path.as_slice() {
            ["LandXML", "Surfaces", "Surface", "Definition", "Boundaries", "Boundary", "PntList3D"] => {
                Some(PolylineCategory::Boundary)
            }
            ["LandXML", "Surfaces", "Surface", "Definition", "Breaklines", "Breakline", "PntList3D"] => {
                Some(PolylineCategory::Breakline)
            }
            ["LandXML", "Surfaces", "Surface", "Definition", "Contours", "Contour", "PntList3D"] => {
                Some(PolylineCategory::Contour)
            }
            _ => None,
        }
    }
}
