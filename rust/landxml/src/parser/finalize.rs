/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;

impl Parser<'_> {
    pub(super) fn finish_surface(&mut self) -> Result<()> {
        let surface = self.surface.take().expect("surface closing");
        if !surface.tin {
            self.warnings.push(format!(
                "Skipped non-TIN or undefined surface \"{}\"",
                surface.name
            ));
            return Ok(());
        }
        if surface.points.len() < 3 {
            return Err(error(
                Code::InvalidSemantic,
                "TIN surface needs at least three points",
            ));
        }
        if surface.faces.is_empty() {
            return Err(error(
                Code::InvalidSemantic,
                "TIN surface has no visible faces",
            ));
        }
        for face in &surface.faces {
            for id in face {
                if !surface.ids.contains(id) {
                    return Err(error(
                        Code::InvalidSemantic,
                        "face references unknown point",
                    ));
                }
            }
        }
        self.surface_ordinal += 1;
        self.surfaces.push(LandXmlSurface {
            source_id: LandXmlSourceId(format!(
                "landxml:surface:{}:{}",
                self.surface_ordinal, surface.name
            )),
            name: surface.name,
            points: surface.points,
            faces: surface.faces,
        });
        Ok(())
    }

    pub(super) fn finish(self) -> Result<LandXmlTinDocument> {
        if self.surfaces.is_empty() {
            return Err(error(
                Code::InvalidSemantic,
                "document contains no renderable TIN surfaces",
            ));
        }
        Ok(LandXmlTinDocument {
            version: "1.2".to_owned(),
            units: self
                .units
                .ok_or_else(|| error(Code::InvalidSemantic, "document is missing Units"))?,
            surfaces: self.surfaces,
            warnings: self.warnings,
        })
    }
}
