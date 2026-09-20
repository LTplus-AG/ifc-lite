/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;

impl Parser<'_> {
    pub(super) fn finish_surface(&mut self) -> Result<()> {
        let mut surface = self.surface.take().expect("surface closing");
        self.surface_ordinal += 1;
        let source_id = LandXmlSourceId(format!("landxml:surface:{}", self.surface_ordinal));
        for point in &mut surface.points {
            point.source_id = LandXmlSourceId(format!("{}:point:{}", source_id.0, point.id));
        }
        for (index, line) in surface.boundaries.iter_mut().enumerate() {
            line.source_id = LandXmlSourceId(format!("{}:boundary:{}", source_id.0, index + 1));
        }
        for (index, line) in surface.breaklines.iter_mut().enumerate() {
            line.source_id = LandXmlSourceId(format!("{}:breakline:{}", source_id.0, index + 1));
        }
        for (index, line) in surface.contours.iter_mut().enumerate() {
            line.source_id = LandXmlSourceId(format!("{}:contour:{}", source_id.0, index + 1));
        }
        let render_state = match surface.kind {
            LandXmlSurfaceKind::Tin if surface.points.len() >= 3 && !surface.faces.is_empty() => {
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
                LandXmlRenderState::Rendered
            }
            LandXmlSurfaceKind::Tin => {
                self.warnings.push(format!(
                    "TIN surface \"{}\" has no renderable topology; source data was preserved",
                    surface.name
                ));
                LandXmlRenderState::PreservedOnly
            }
            LandXmlSurfaceKind::Grid | LandXmlSurfaceKind::Volume => {
                let label = if surface.kind == LandXmlSurfaceKind::Grid {
                    "GRID"
                } else {
                    "volume"
                };
                self.warnings.push(format!(
                    "Preserved {label} surface \"{}\" without guessed topology",
                    surface.name
                ));
                LandXmlRenderState::PreservedOnly
            }
            LandXmlSurfaceKind::Other => {
                self.warnings.push(format!(
                    "Unsupported or undefined surface \"{}\" was preserved without rendering",
                    surface.name
                ));
                LandXmlRenderState::Unsupported
            }
        };
        let face_source_ids = (0..surface.faces.len())
            .map(|index| LandXmlSourceId(format!("{}:face:{}", source_id.0, index + 1)))
            .collect();
        self.surfaces.push(LandXmlSurface {
            source_id,
            name: surface.name,
            kind: surface.kind,
            render_state,
            points: surface.points,
            faces: surface.faces,
            face_source_ids,
            hidden_face_count: surface.hidden_face_count,
            boundaries: surface.boundaries,
            breaklines: surface.breaklines,
            contours: surface.contours,
        });
        Ok(())
    }

    pub(super) fn finish(mut self) -> Result<LandXmlTinDocument> {
        if !self.extensions.is_empty() {
            self.warnings.push(format!(
                "Preserved {} unknown vendor extension root(s) as source metadata",
                self.extensions.len(),
            ));
        }
        Ok(LandXmlTinDocument {
            version: "1.2".to_owned(),
            units: self.units,
            surfaces: self.surfaces,
            extensions: self.extensions,
            warnings: self.warnings,
        })
    }
}
